import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, SessionStatus } from '../../domain';
import type { Actor, ApprovalRequest, Session, Task } from '../../domain';
import { CALENDAR_EVENT_LOCATION_MAX_LENGTH, CALENDAR_EVENT_TITLE_MAX_LENGTH, boundCalendarText, type CalendarEvent, type CalendarReader } from '../../ports/calendar-reader.port';
import {
  connectorWriteNotSent,
  connectorWriteSent,
  type CalendarEventRestoreRequest,
  type CalendarEventUpdateRequest,
  type CalendarEventWriter,
  type ConnectorWriteOutcome,
} from '../../ports/connector-write.port';
import type {
  ConnectorWriteMatch,
  ConnectorWritePrepareResult,
  ConnectorWriteReceipt,
  ConnectorWriteReceiptRepository,
} from '../../ports/connector-write-receipt.port';
import {
  LAST_ACTION_METADATA_KEY,
  externalUndoFamilyOf,
  isExternalUndoOpen,
  setExternalUndoCapabilitiesForTest,
  withLastAction,
  type LastActionRecord,
} from '../nl-routing/last-action';
import { plainTextOf } from '../message-rendering';
import { CONNECTOR_UNDO_RECEIPT_BANNER, renderConnectorWriteStep } from './connector-write-copy';
import type { ExternalUndoDraftKind } from './connector-write-draft';
import { StatelessConnectorWriteFlow, type ConnectorWriteStep } from './connector-write-flow';

// ADR-0112 amendment 3 (O2, O3, O6, O7): the undo of an approved calendar UPDATE (patch back only the changed fields,
// compare-and-set on Quoky's own post-update version) and the RESTORE of an approved calendar DELETE (the same event id, never
// a copy), through the real flow. Storage, approvals, receipts, the writer and the reader are in-memory fakes; the runtime's
// `recordExternalWrite` is emulated by writing the same `lastAction` record (receipt id, anchor task id, operation).

const SEOUL = 'Asia/Seoul';
const T0 = '2026-11-02T01:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const OWNER: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
const OTHER: Actor = { id: 'other', displayName: 'Other', identities: [], createdAt: T0 };
const EVENT_ID = 'abcde12345';
// 2026-11-03 15:00-16:00 Asia/Seoul.
const START = '2026-11-03T06:00:00.000Z';
const END = '2026-11-03T07:00:00.000Z';
const REF = {
  date: { year: 2026, month: 11, day: 3 },
  window: { from: '2026-11-02T15:00:00.000Z', to: '2026-11-03T15:00:00.000Z' },
  startTime: { hour: 15, minute: 0 },
  titleWords: [] as string[],
};

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
  async findSentUndoOf(): Promise<ConnectorWriteReceipt | null> {
    return null;
  }
  async markInterruptedPreparedUncertain(): Promise<number> {
    return 0;
  }
}

interface HarnessOptions {
  /** The event as it is before the owner's update / delete (a location, or none). */
  readonly location?: string | undefined;
  readonly title?: string;
  /** Whether the writer reports the post-update version (the real writer does). */
  readonly updateVersion?: boolean;
  /** What the writer answers to a restore instead of restoring (a refusal by the calendar). */
  readonly restoreOutcome?: ConnectorWriteOutcome;
  /** The provider's RAW title / location: the reader shows them bounded and marks whether that is byte-exact (as the adapter). */
  readonly rawTitle?: string;
  readonly rawLocation?: string;
  /** The event's recorded start time zone (`null`: the provider records none). Default: Asia/Seoul. */
  readonly eventTimeZone?: string | null;
}

function harness(options: HarnessOptions = {}) {
  let version = 1;
  const rawTitle = options.rawTitle ?? options.title ?? '주간 회의';
  const shownTitle = boundCalendarText(rawTitle, CALENDAR_EVENT_TITLE_MAX_LENGTH);
  const shownLocation = options.rawLocation !== undefined ? boundCalendarText(options.rawLocation, CALENDAR_EVENT_LOCATION_MAX_LENGTH) : undefined;
  const base: CalendarEvent = {
    id: EVENT_ID,
    title: shownTitle,
    start: START,
    end: END,
    allDay: false,
    status: 'confirmed',
    calendarName: 'primary',
    version: `"v${version}"`,
    ...(shownLocation !== undefined ? { location: shownLocation } : 'location' in options ? (options.location !== undefined ? { location: options.location } : {}) : { location: '3층' }),
    ...(options.eventTimeZone === null ? {} : { timeZone: options.eventTimeZone ?? SEOUL }),
    lossless: { title: shownTitle === rawTitle, location: options.rawLocation === undefined || shownLocation === options.rawLocation },
  };
  const live: { events: CalendarEvent[]; deleted: CalendarEvent[] } = { events: [base], deleted: [] };
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, Task>();
  const approvals = new Map<string, ApprovalRequest>();
  const writes = { update: [] as CalendarEventUpdateRequest[], restore: [] as CalendarEventRestoreRequest[], delete: 0, create: 0 };
  const reads = { list: 0, get: [] as Array<{ calendarId: string; eventId: string }> };
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
      reads.list += 1;
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      return live.events.filter((event) => Date.parse(event.end) > from && Date.parse(event.start) < to);
    },
    async getEvent(calendarId, eventId) {
      reads.get.push({ calendarId, eventId });
      // Like the real adapter: a deleted (cancelled) event reads as absent.
      return live.events.find((event) => event.id === eventId);
    },
    async getEventPresence(calendarId, eventId) {
      reads.get.push({ calendarId, eventId });
      const event = live.events.find((candidate) => candidate.id === eventId);
      if (event !== undefined) return { kind: 'live', event };
      const deleted = live.deleted.find((candidate) => candidate.id === eventId);
      return deleted !== undefined ? { kind: 'deleted', event: deleted } : { kind: 'absent' };
    },
  };
  const bump = (): string => `"v${(version += 1)}"`;
  const writer: CalendarEventWriter = {
    source: 'calendar',
    target: 'primary',
    async createEvent() {
      writes.create += 1;
      return connectorWriteNotSent('INVALID_REQUEST');
    },
    async updateEvent(request) {
      writes.update.push(structuredClone(request));
      const event = live.events.find((candidate) => candidate.id === request.eventId);
      if (event === undefined) return connectorWriteNotSent('NOT_FOUND');
      // Compare-and-set, as `If-Match` does at the provider: an edit since the bound version is refused, nothing applied.
      if (event.version !== request.expected.version) return connectorWriteNotSent('TARGET_CHANGED');
      const changes = request.changes;
      const time = changes.time;
      const next: CalendarEvent = {
        ...event,
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.location !== undefined ? { location: changes.location } : {}),
        ...(time !== undefined && !time.allDay ? { start: new Date(Date.parse(time.start)).toISOString(), end: new Date(Date.parse(time.end)).toISOString() } : {}),
        version: bump(),
      };
      live.events = live.events.map((candidate) => (candidate.id === request.eventId ? next : candidate));
      return connectorWriteSent(request.eventId, undefined, options.updateVersion === false ? undefined : next.version);
    },
    async deleteEvent(request) {
      writes.delete += 1;
      const event = live.events.find((candidate) => candidate.id === request.eventId);
      if (event === undefined) return connectorWriteNotSent('NOT_FOUND');
      if (event.version !== request.expected.version) return connectorWriteNotSent('TARGET_CHANGED');
      live.events = live.events.filter((candidate) => candidate.id !== request.eventId);
      live.deleted.push({ ...event, version: bump() });
      return connectorWriteSent(request.eventId);
    },
    async restoreEvent(request) {
      writes.restore.push(structuredClone(request));
      if (options.restoreOutcome !== undefined) return options.restoreOutcome;
      const event = live.deleted.find((candidate) => candidate.id === request.eventId);
      if (event === undefined) return connectorWriteNotSent('NOT_FOUND');
      if (event.allDay !== request.expected.allDay || event.start !== request.expected.start || event.end !== request.expected.end || event.title !== request.expected.title) {
        return connectorWriteNotSent('TARGET_CHANGED');
      }
      live.deleted = live.deleted.filter((candidate) => candidate.id !== request.eventId);
      const restored = { ...event, version: bump() };
      live.events.push(restored);
      return connectorWriteSent(request.eventId, undefined, restored.version);
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

  /** What the runtime's recordExternalWrite stores for an approved connector write. */
  function recordLastAction(input: {
    receiptId: string;
    anchorTaskId?: string;
    operation?: LastActionRecord['operation'];
    actorId?: string;
    at?: string;
    entryId?: LastActionRecord['entryId'];
    outcome?: LastActionRecord['outcome'];
  }): void {
    const entryId = input.entryId ?? 'external.write';
    const record: LastActionRecord = {
      entryId,
      source: 'calendar',
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

  async function runWrite(draft: Parameters<typeof flow.prepare>[0]['draft'], operation: 'CALENDAR_EVENT_UPDATE' | 'CALENDAR_EVENT_DELETE') {
    const preview = await flow.prepare({ session: session(), actor: OWNER, now: at(0), draft });
    expect(preview.kind).toBe('preview');
    const anchorTaskId = (await flow.find(session()))?.taskId as string;
    const step = await approveAndExecute(at(1));
    if (step.kind !== 'outcome' || step.receiptId === undefined) throw new Error('the write did not run');
    recordLastAction({ receiptId: step.receiptId, anchorTaskId, operation });
    return { receiptId: step.receiptId, anchorTaskId, step };
  }

  /** "내일 3시 회의 4시로 옮기고 제목 바꿔줘" (or the given changes), approved and executed. */
  const updateEvent = (changes: { moveTo?: { time: { hour: number; minute: number } }; title?: string; location?: string } = { moveTo: { time: { hour: 16, minute: 0 } }, title: '주간 회의 (변경)' }) =>
    runWrite({ kind: 'calendar-update', ref: REF, changes }, 'CALENDAR_EVENT_UPDATE');
  /** "내일 3시 회의 취소해줘", approved and executed. */
  const deleteEvent = () => runWrite({ kind: 'calendar-delete', ref: REF }, 'CALENDAR_EVENT_DELETE');

  const undo = (kind: ExternalUndoDraftKind, receiptId: string, now: string, actor: Actor = OWNER, sessionId = 'sess-1', extra: { ownerText?: string } = {}) =>
    flow.prepare({ session: session(sessionId), actor, now, draft: { kind, receiptId }, ...extra });

  return { flow, session, writes, reads, live, receipts, tasks, approveAndExecute, recordLastAction, updateEvent, deleteEvent, undo };
}

const reason = (step: ConnectorWriteStep): string | undefined => (step.kind === 'refused' ? step.reason : undefined);

describe('ADR-0112 amendment 3 (O2): the undo of an approved calendar update', () => {
  beforeEach(() => setExternalUndoCapabilitiesForTest(['calendar-create', 'calendar-update', 'calendar-delete']));
  afterEach(() => setExternalUndoCapabilitiesForTest());

  it('the update receipt keeps the post-update version the writer returned', async () => {
    const h = harness();
    const { receiptId } = await h.updateEvent();
    expect(h.receipts.rows.get(receiptId)).toMatchObject({ operation: 'CALENDAR_EVENT_UPDATE', target: `primary/${EVENT_ID}`, data: { externalRef: EVENT_ID, version: '"v2"' } });
  });

  it('previews with the receipt banner and a CRITICAL approval, then patches back ONLY the changed fields with If-Match on the post-update version', async () => {
    const h = harness();
    const { receiptId } = await h.updateEvent();
    const step = await h.undo('calendar-update-undo', receiptId, at(3));
    expect(step.kind).toBe('preview');
    if (step.kind !== 'preview') return;
    expect(step.approval.riskLevel).toBe('CRITICAL');
    expect(step.executionPhrase).toBe('일정 변경 실행');
    expect(step.preview).toMatchObject({ operation: 'CALENDAR_EVENT_UPDATE', receiptSourced: true, before: { id: EVENT_ID, title: '주간 회의 (변경)' }, after: { title: '주간 회의', location: '3층' } });
    const text = plainTextOf(renderConnectorWriteStep(step));
    expect(text).toContain(CONNECTOR_UNDO_RECEIPT_BANNER);
    expect(text).toContain('방금 Quoky가 바꾼 이 일정을 바꾸기 전 값으로 되돌려요.');
    expect(h.writes.update).toHaveLength(1);

    const outcome = await h.approveAndExecute(at(4));
    expect(outcome).toMatchObject({ kind: 'outcome', operation: 'CALENDAR_EVENT_UPDATE', outcome: { status: 'SENT' } });
    expect(plainTextOf(renderConnectorWriteStep(outcome))).toBe('방금 바꾼 일정을 바꾸기 전으로 되돌렸어요. 변경 메일은 보내지 않았어요.');
    const inverse = h.writes.update[1] as CalendarEventUpdateRequest;
    expect(inverse.eventId).toBe(EVENT_ID);
    // Title and time were changed, so they go back; the location was not, so it is not in the patch.
    expect(inverse.changes).toEqual({ title: '주간 회의', time: { allDay: false, start: START, end: END, timeZone: SEOUL } });
    expect(Object.keys(inverse.changes)).not.toContain('location');
    expect(inverse.expected).toEqual({ allDay: false, start: '2026-11-03T07:00:00.000Z', end: '2026-11-03T08:00:00.000Z', version: '"v2"' });
    expect(h.live.events).toEqual([expect.objectContaining({ id: EVENT_ID, title: '주간 회의', start: START, end: END, location: '3층' })]);
  });

  it('a location-only update is undone by patching the location only', async () => {
    const h = harness();
    const { receiptId } = await h.updateEvent({ location: '5층 대회의실' });
    expect((await h.undo('calendar-update-undo', receiptId, at(3))).kind).toBe('preview');
    await h.approveAndExecute(at(4));
    expect(h.writes.update[1]?.changes).toEqual({ location: '3층' });
  });

  it('CAS at preview: an edit after Quoky\'s update (version, title, time or location) is undo-event-changed and writes nothing', async () => {
    for (const edit of [
      (event: CalendarEvent) => ({ ...event, version: '"v-edited"' }),
      (event: CalendarEvent) => ({ ...event, title: '누가 바꾼 제목' }),
      (event: CalendarEvent) => ({ ...event, start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' }),
    ]) {
      const h = harness();
      const { receiptId } = await h.updateEvent();
      h.live.events = h.live.events.map(edit);
      expect(reason(await h.undo('calendar-update-undo', receiptId, at(3)))).toBe('undo-event-changed');
      expect(h.writes.update).toHaveLength(1);
      expect((await h.flow.find(h.session()))?.anchor.status).not.toBe('APPROVAL_PENDING');
    }
    const located = harness();
    const { receiptId } = await located.updateEvent({ location: '5층 대회의실' });
    located.live.events = located.live.events.map((event) => ({ ...event, location: '지하 1층' }));
    expect(reason(await located.undo('calendar-update-undo', receiptId, at(3)))).toBe('undo-event-changed');
  });

  it('CAS at execution: an edit between the preview and the phrase is TARGET_CHANGED, nothing is patched, and the copy says so', async () => {
    const h = harness();
    const { receiptId } = await h.updateEvent();
    expect((await h.undo('calendar-update-undo', receiptId, at(3))).kind).toBe('preview');
    h.live.events = h.live.events.map((event) => ({ ...event, version: '"v-edited-meanwhile"' }));
    const outcome = await h.approveAndExecute(at(4));
    expect(outcome).toMatchObject({ kind: 'outcome', outcome: { status: 'NOT_SENT', reason: 'TARGET_CHANGED' } });
    expect(h.writes.update[1]?.expected.version).toBe('"v2"');
    expect(h.live.events[0]).toMatchObject({ title: '주간 회의 (변경)' });
    expect(plainTextOf(renderConnectorWriteStep(outcome))).toContain('되돌리지 못했어요 — 미리보기 이후 일정이 바뀌어서 고치지 않았어요');
  });

  it('refuses (fail closed, no partial inverse) when an old value cannot be written back or no post-update version was reported', async () => {
    const noLocation = harness({ location: undefined });
    const added = await noLocation.updateEvent({ location: '5층', title: '새 제목' });
    const step = await noLocation.undo('calendar-update-undo', added.receiptId, at(3));
    expect(reason(step)).toBe('undo-unavailable');
    expect(plainTextOf(renderConnectorWriteStep(step))).toContain('이 일정 변경은 자동으로 되돌릴 수 없어요. 캘린더에서 직접 고쳐 주세요');

    const unversioned = harness({ updateVersion: false });
    const second = await unversioned.updateEvent();
    expect(reason(await unversioned.undo('calendar-update-undo', second.receiptId, at(3)))).toBe('undo-unavailable');
    expect(noLocation.writes.update).toHaveLength(1);
    expect(unversioned.writes.update).toHaveLength(1);
  });

  it('review round 1 (P2): a changed text field whose shown value is not byte-exact is never written back (250-char title, newline title, long location); an exact one is restored byte for byte', async () => {
    const long = '가'.repeat(250);
    for (const [options, changes] of [
      [{ rawTitle: long }, { title: '짧은 제목' }],
      [{ rawTitle: '주간\n회의' }, { title: '새 제목' }],
      [{ rawLocation: `${'3층 '.repeat(100)}끝` }, { location: '5층' }],
    ] as const) {
      const h = harness(options);
      const { receiptId } = await h.updateEvent(changes);
      const step = await h.undo('calendar-update-undo', receiptId, at(3));
      expect(reason(step)).toBe('undo-unavailable');
      expect(plainTextOf(renderConnectorWriteStep(step))).toContain('이 일정 변경은 자동으로 되돌릴 수 없어요');
      expect(h.writes.update).toHaveLength(1);
      expect((await h.flow.find(h.session()))?.anchor.status).not.toBe('APPROVAL_PENDING');
    }
    const exactTitle = `${'나'.repeat(198)}끝`;
    const exact = harness({ rawTitle: exactTitle, rawLocation: '3층 대회의실' });
    const { receiptId } = await exact.updateEvent({ title: '짧은 제목', location: '5층' });
    expect((await exact.undo('calendar-update-undo', receiptId, at(3))).kind).toBe('preview');
    await exact.approveAndExecute(at(4));
    expect(exact.writes.update[1]?.changes).toEqual({ title: exactTitle, location: '3층 대회의실' });
    expect(exact.live.events[0]).toMatchObject({ title: exactTitle, location: '3층 대회의실' });
  });

  it('review round 2: execution re-derives the inverse from the undone update\'s anchor; a persisted pre-fix card (no source link, no lossless marker) writes nothing', async () => {
    const raw = '가'.repeat(300);
    const rawLocation = '층'.repeat(300);
    type AnchorRecord = Record<string, unknown> & { preview: { before: Record<string, unknown> }; undoOf?: Record<string, unknown> };
    const anchorOf = (h: ReturnType<typeof harness>, taskId: string): AnchorRecord => h.tasks.get(taskId)?.metadata?.connectorWriteAnchor as AnchorRecord;
    const setAnchor = (h: ReturnType<typeof harness>, taskId: string, next: AnchorRecord): void => {
      const task = h.tasks.get(taskId) as Task;
      h.tasks.set(taskId, { ...task, metadata: { ...task.metadata, connectorWriteAnchor: next } });
    };
    for (const shape of ['pre-fix card (no source link, no marker)', 'source link kept, marker missing', 'source link kept, marker false'] as const) {
      const h = harness({ rawTitle: raw, rawLocation });
      const { receiptId, anchorTaskId } = await h.updateEvent({ title: '짧은 제목', location: '5층' });
      // Build the card the pre-fix proposal would have persisted: its inverse writes the BOUNDED 200-character values back.
      const source = anchorOf(h, anchorTaskId);
      const legacyBefore = { ...source.preview.before };
      setAnchor(h, anchorTaskId, { ...source, preview: { ...source.preview, before: { ...legacyBefore, lossless: { title: true, location: true } } } });
      expect((await h.undo('calendar-update-undo', receiptId, at(3))).kind).toBe('preview');
      const pending = await h.flow.find(h.session());
      const card = anchorOf(h, pending?.taskId as string);
      expect((card.payload as { changes: { title: string } }).changes.title).toHaveLength(200);
      const { lossless: _marker, ...unmarked } = legacyBefore;
      setAnchor(h, anchorTaskId, { ...source, preview: { ...source.preview, before: shape === 'source link kept, marker false' ? { ...legacyBefore, lossless: { title: false, location: false } } : unmarked } });
      if (shape === 'pre-fix card (no source link, no marker)') {
        const { sourceTaskId: _link, ...legacyLink } = card.undoOf as Record<string, unknown>;
        setAnchor(h, pending?.taskId as string, { ...card, undoOf: legacyLink });
      }
      const step = await h.approveAndExecute(at(4));
      expect(reason(step), shape).toBe('undo-unavailable');
      expect(h.writes.update, shape).toHaveLength(1);
      expect(h.live.events[0]?.title, shape).toBe('짧은 제목');
    }
  });

  it('review round 1 (P3-4): a time undo needs the event\'s recorded start time zone to be the zone the update wrote; otherwise it is refused, never restamped', async () => {
    for (const eventTimeZone of [null, 'America/New_York'] as const) {
      const h = harness({ eventTimeZone });
      const { receiptId } = await h.updateEvent({ moveTo: { time: { hour: 16, minute: 0 } } });
      expect(reason(await h.undo('calendar-update-undo', receiptId, at(3)))).toBe('undo-unavailable');
      expect(h.writes.update).toHaveLength(1);
    }
    const same = harness();
    const { receiptId } = await same.updateEvent({ moveTo: { time: { hour: 16, minute: 0 } } });
    expect((await same.undo('calendar-update-undo', receiptId, at(3))).kind).toBe('preview');
  });

  it('the event gone is undo-event-gone; a read is one event by its receipt id, never a listing', async () => {
    const h = harness();
    const { receiptId } = await h.updateEvent();
    const listsBefore = h.reads.list;
    h.live.events = [];
    expect(reason(await h.undo('calendar-update-undo', receiptId, at(3)))).toBe('undo-event-gone');
    expect(h.reads.get).toEqual([{ calendarId: 'primary', eventId: EVENT_ID }]);
    expect(h.reads.list).toBe(listsBefore);
  });

  it('only this actor\'s own fresh lastAction reaches it: another actor, another session, a stale record, another receipt id or the other family\'s draft is undo-nothing', async () => {
    const h = harness();
    const { receiptId } = await h.updateEvent();
    expect(reason(await h.undo('calendar-update-undo', receiptId, at(3), OTHER))).toBe('undo-nothing');
    expect(reason(await h.undo('calendar-update-undo', receiptId, at(3), OWNER, 'sess-2'))).toBe('undo-nothing');
    expect(reason(await h.undo('calendar-update-undo', receiptId, at(12)))).toBe('undo-nothing');
    expect(reason(await h.undo('calendar-update-undo', 'some-other-receipt', at(3)))).toBe('undo-nothing');
    expect(reason(await h.undo('calendar-delete-undo', receiptId, at(3)))).toBe('undo-nothing');
    expect(reason(await h.undo('calendar-create-undo', receiptId, at(3)))).toBe('undo-nothing');
    expect(h.writes.update).toHaveLength(1);
  });

  it('a record without the operation (written before this slice) or with the family closed stays not undoable', async () => {
    const h = harness();
    const { receiptId, anchorTaskId } = await h.updateEvent();
    h.recordLastAction({ receiptId, anchorTaskId });
    expect(reason(await h.undo('calendar-update-undo', receiptId, at(3)))).toBe('undo-nothing');
    h.recordLastAction({ receiptId, anchorTaskId, operation: 'CALENDAR_EVENT_UPDATE' });
    setExternalUndoCapabilitiesForTest(['calendar-create']);
    expect(reason(await h.undo('calendar-update-undo', receiptId, at(3)))).toBe('undo-nothing');
  });

  it('the undo anchor is marked as an undo (the runtime records action.undo, so an undo of the undo is refused)', async () => {
    const h = harness();
    const { receiptId, anchorTaskId } = await h.updateEvent();
    await h.undo('calendar-update-undo', receiptId, at(3));
    const view = await h.flow.find(h.session());
    expect(view?.anchor.undoOf).toEqual({ entryId: 'external.write', receiptId, family: 'calendar-update', sourceTaskId: anchorTaskId });
    const done = await h.approveAndExecute(at(4));
    if (done.kind !== 'outcome' || done.receiptId === undefined) throw new Error('undo did not run');
    h.recordLastAction({ receiptId: done.receiptId, anchorTaskId: view?.taskId, entryId: 'action.undo', operation: 'CALENDAR_EVENT_UPDATE', at: at(4) });
    expect(reason(await h.undo('calendar-update-undo', done.receiptId, at(5)))).toBe('undo-nothing');
    // Even a forged record that names the undo's own receipt as an ordinary update is refused: its anchor is an undo.
    h.recordLastAction({ receiptId: done.receiptId, anchorTaskId: view?.taskId, operation: 'CALENDAR_EVENT_UPDATE', at: at(4) });
    expect(reason(await h.undo('calendar-update-undo', done.receiptId, at(5)))).toBe('undo-nothing');
    expect(h.writes.update).toHaveLength(2);
  });
});

describe('ADR-0112 amendment 3 (O3, O6, O7): the restore of an approved calendar delete', () => {
  beforeEach(() => setExternalUndoCapabilitiesForTest(['calendar-create', 'calendar-update', 'calendar-delete']));
  afterEach(() => setExternalUndoCapabilitiesForTest());

  it('previews a receipt-sourced restore with its own exact phrase, then restores the SAME event id through restoreEvent (never a create)', async () => {
    const h = harness();
    const { receiptId } = await h.deleteEvent();
    expect(h.live.events).toEqual([]);
    const step = await h.undo('calendar-delete-undo', receiptId, at(3), OWNER, 'sess-1', { ownerText: '방금 지운 거 되돌려줘' });
    expect(step.kind).toBe('preview');
    if (step.kind !== 'preview') return;
    expect(step.approval.riskLevel).toBe('CRITICAL');
    expect(step.executionPhrase).toBe('일정 복원 실행');
    expect(step.preview).toMatchObject({ operation: 'CALENDAR_EVENT_RESTORE', receiptSourced: true, before: { id: EVENT_ID, title: '주간 회의' } });
    const text = plainTextOf(renderConnectorWriteStep(step));
    expect(text).toContain(CONNECTOR_UNDO_RECEIPT_BANNER);
    expect(text).toContain('같은 일정으로 복원해요. 새 일정을 따로 만들지 않아요.');
    expect(text).toContain('"일정 복원 실행"');
    expect(text).toContain('요청하신 문장: ');
    expect(h.writes.restore).toHaveLength(0);

    const outcome = await h.approveAndExecute(at(4));
    expect(outcome).toMatchObject({ kind: 'outcome', operation: 'CALENDAR_EVENT_RESTORE', outcome: { status: 'SENT', externalRef: EVENT_ID } });
    expect(h.writes.restore).toEqual([{ eventId: EVENT_ID, expected: { allDay: false, start: START, end: END, title: '주간 회의' } }]);
    expect(h.writes.create).toBe(0);
    expect(h.live.events.map((event) => event.id)).toEqual([EVENT_ID]);
    expect(plainTextOf(renderConnectorWriteStep(outcome))).toBe('방금 삭제한 일정을 같은 일정으로 복원했어요. 알림 메일은 보내지 않았어요.');
    expect(h.receipts.rows.get(outcome.kind === 'outcome' ? (outcome.receiptId as string) : '')).toMatchObject({ operation: 'CALENDAR_EVENT_RESTORE', target: `primary/${EVENT_ID}` });
  });

  it('a refusal by the calendar is said plainly (not found, forbidden, changed); nothing is re-created', async () => {
    for (const [refusal, expected] of [
      [connectorWriteNotSent('NOT_FOUND'), '복원하지 못했어요 — 캘린더가 그 일정을 더 이상 찾을 수 없다고 답했어요'],
      [connectorWriteNotSent('FORBIDDEN'), '복원하지 못했어요 — 캘린더가 복원을 받아 주지 않았어요: 권한이 없어요.'],
      [connectorWriteNotSent('REJECTED'), '복원하지 못했어요 — 캘린더가 복원을 받아 주지 않았어요: 상대 서비스가 요청을 거부했어요.'],
      [connectorWriteNotSent('TARGET_CHANGED'), '복원하지 못했어요 — 삭제한 뒤 그 일정이 바뀌었거나 이미 다시 있어요.'],
    ] as const) {
      const h = harness({ restoreOutcome: refusal });
      const { receiptId } = await h.deleteEvent();
      expect((await h.undo('calendar-delete-undo', receiptId, at(3))).kind).toBe('preview');
      const outcome = await h.approveAndExecute(at(4));
      expect(outcome).toMatchObject({ kind: 'outcome', outcome: { status: 'NOT_SENT', reason: refusal.status === 'NOT_SENT' ? refusal.reason : '' } });
      const text = plainTextOf(renderConnectorWriteStep(outcome));
      expect(text).toContain(expected);
      expect(text).toContain('이번 요청으로 캘린더를 바꾸지 않았어요');
      expect(h.writes.create).toBe(0);
      expect(h.live.events).toEqual([]);
    }
  });

  it('an event that is back on the calendar (restored or re-created meanwhile) is undo-event-present: no preview, no write', async () => {
    const h = harness();
    const { receiptId } = await h.deleteEvent();
    h.live.events.push({ id: EVENT_ID, title: '주간 회의', start: START, end: END, allDay: false, status: 'confirmed', calendarName: 'primary', version: '"v-back"' });
    const step = await h.undo('calendar-delete-undo', receiptId, at(3));
    expect(reason(step)).toBe('undo-event-present');
    expect(plainTextOf(renderConnectorWriteStep(step))).toContain('그 일정은 이미 캘린더에 다시 있어요. 복원하지 않았어요.');
    expect(h.writes.restore).toHaveLength(0);
    expect((await h.flow.find(h.session()))?.anchor.status).not.toBe('APPROVAL_PENDING');
  });

  it('only this actor\'s own fresh delete receipt reaches it; the restore of an undo\'s delete is refused', async () => {
    const h = harness();
    const { receiptId, anchorTaskId } = await h.deleteEvent();
    expect(reason(await h.undo('calendar-delete-undo', receiptId, at(3), OTHER))).toBe('undo-nothing');
    expect(reason(await h.undo('calendar-delete-undo', receiptId, at(3), OWNER, 'sess-2'))).toBe('undo-nothing');
    expect(reason(await h.undo('calendar-delete-undo', receiptId, at(12)))).toBe('undo-nothing');
    expect(reason(await h.undo('calendar-update-undo', receiptId, at(3)))).toBe('undo-nothing');
    h.recordLastAction({ receiptId, anchorTaskId, outcome: 'UNCERTAIN', operation: 'CALENDAR_EVENT_DELETE' });
    expect(reason(await h.undo('calendar-delete-undo', receiptId, at(3)))).toBe('undo-nothing');
    expect(h.writes.restore).toHaveLength(0);
  });

  it('a restore is never undone again, and the kill-switch flag rides on its anchor (undoOf set)', async () => {
    const h = harness();
    const { receiptId } = await h.deleteEvent();
    await h.undo('calendar-delete-undo', receiptId, at(3));
    const view = await h.flow.find(h.session());
    expect(view?.anchor.undoOf).toEqual({ entryId: 'external.write', receiptId, family: 'calendar-delete' });
    const done = await h.approveAndExecute(at(4));
    if (done.kind !== 'outcome' || done.receiptId === undefined) throw new Error('restore did not run');
    h.recordLastAction({ receiptId: done.receiptId, anchorTaskId: view?.taskId, entryId: 'action.undo', operation: 'CALENDAR_EVENT_RESTORE', at: at(4) });
    expect(reason(await h.undo('calendar-delete-undo', done.receiptId, at(5)))).toBe('undo-nothing');
    expect(externalUndoFamilyOf('external.write', 'CALENDAR_EVENT_RESTORE')).toBeUndefined();
  });

  it('review round 1 (P3-1): a purged event (the calendar no longer knows the id) gets a plain "복원할 수 없어요" and no approval card; a deleted event that changed is refused too', async () => {
    const h = harness();
    const { receiptId } = await h.deleteEvent();
    const deleted = h.live.deleted.splice(0);
    const purged = await h.undo('calendar-delete-undo', receiptId, at(3));
    expect(reason(purged)).toBe('undo-event-gone');
    expect(plainTextOf(renderConnectorWriteStep(purged))).toContain('복원할 수 없어요');
    expect((await h.flow.find(h.session()))?.anchor.status).not.toBe('APPROVAL_PENDING');
    h.live.deleted.push({ ...(deleted[0] as CalendarEvent), title: '다른 제목' });
    expect(reason(await h.undo('calendar-delete-undo', receiptId, at(3)))).toBe('undo-event-changed');
    expect(h.writes.restore).toHaveLength(0);
  });

  it('review round 1 (P3-3): an approved restore anchor without the calendar-delete undo link never executes', async () => {
    const h = harness();
    const { receiptId } = await h.deleteEvent();
    expect((await h.undo('calendar-delete-undo', receiptId, at(3))).kind).toBe('preview');
    const view = await h.flow.find(h.session());
    const task = h.tasks.get(view?.taskId as string) as Task;
    const anchor = task.metadata?.connectorWriteAnchor as Record<string, unknown>;
    h.tasks.set(task.id, { ...task, metadata: { ...task.metadata, connectorWriteAnchor: { ...anchor, undoOf: { entryId: 'external.write', receiptId, family: 'calendar-update' } } } });
    const step = await h.approveAndExecute(at(4));
    expect(reason(step)).toBe('binding-mismatch');
    expect(h.writes.restore).toHaveLength(0);
  });

  it('the restore payload binds the delete\'s own expectation; a restore preview never lists the calendar', async () => {
    const h = harness();
    const { receiptId } = await h.deleteEvent();
    const listsBefore = h.reads.list;
    const step = await h.undo('calendar-delete-undo', receiptId, at(3));
    expect(step.kind).toBe('preview');
    const view = await h.flow.find(h.session());
    expect(view?.anchor.payload).toEqual({ operation: 'CALENDAR_EVENT_RESTORE', eventId: EVENT_ID, expected: { allDay: false, start: START, end: END, title: '주간 회의' }, undoes: receiptId });
    expect(view?.anchor.target).toBe(`primary/${EVENT_ID}`);
    expect(h.reads.list).toBe(listsBefore);
    expect(h.reads.get.at(-1)).toEqual({ calendarId: 'primary', eventId: EVENT_ID });
  });

  it('restore-duplicate fix (live 2026-11-16): delete -> restore -> delete again -> undo previews a NEW restore bound to the new delete receipt', async () => {
    const h = harness();
    const first = await h.deleteEvent();
    expect((await h.undo('calendar-delete-undo', first.receiptId, at(3))).kind).toBe('preview');
    const restored = await h.approveAndExecute(at(4));
    expect(restored).toMatchObject({ kind: 'outcome', outcome: { status: 'SENT', externalRef: EVENT_ID } });
    expect(h.live.events.map((event) => event.id)).toEqual([EVENT_ID]);
    // The owner deletes the same event again (an ordinary approved delete): a new delete receipt.
    const second = await h.deleteEvent();
    expect(second.receiptId).not.toBe(first.receiptId);
    expect(h.live.events).toEqual([]);
    const step = await h.undo('calendar-delete-undo', second.receiptId, at(6));
    expect(step.kind).toBe('preview');
    if (step.kind !== 'preview') return;
    expect(plainTextOf(renderConnectorWriteStep(step))).not.toContain('이미 실행했어요');
    const view = await h.flow.find(h.session());
    expect(view?.anchor.payload).toMatchObject({ operation: 'CALENDAR_EVENT_RESTORE', eventId: EVENT_ID, undoes: second.receiptId });
    expect(view?.anchor.undoOf).toMatchObject({ receiptId: second.receiptId, family: 'calendar-delete' });
    const again = await h.approveAndExecute(at(7));
    expect(again).toMatchObject({ kind: 'outcome', outcome: { status: 'SENT', externalRef: EVENT_ID } });
    expect(h.writes.restore).toHaveLength(2);
    expect(h.live.events.map((event) => event.id)).toEqual([EVENT_ID]);
  });

  it('restore-duplicate fix: the at-most-once guard still refuses a real replay of the SAME restore (same approval, or the same source receipt again)', async () => {
    const h = harness();
    const { receiptId } = await h.deleteEvent();
    expect((await h.undo('calendar-delete-undo', receiptId, at(3))).kind).toBe('preview');
    const done = await h.approveAndExecute(at(4));
    expect(done).toMatchObject({ kind: 'outcome', outcome: { status: 'SENT' } });
    // The same approval replayed: a repeat, never a second restore.
    const view = await h.flow.anchorOfTask(h.session(), ((await h.flow.find(h.session())) ?? { taskId: '' }).taskId);
    const replay = await h.flow.execute({ session: h.session(), actor: OWNER, now: at(5), view: view as NonNullable<typeof view> });
    expect(replay).toMatchObject({ kind: 'repeat', operation: 'CALENDAR_EVENT_RESTORE', status: 'SENT' });
    // The same source receipt undone again (the event deleted again outside Quoky, the lastAction still the old delete): the
    // identity is the same source receipt, so its own SENT restore matches and nothing is restored twice.
    const back = h.live.events.splice(0);
    h.live.deleted.push(...back);
    const repeated = await h.undo('calendar-delete-undo', receiptId, at(6));
    expect(repeated.kind).toBe('already-sent');
    expect(h.writes.restore).toHaveLength(1);
  });

  it('restore-duplicate fix: an approved undo whose payload names another source receipt than its undo link never executes', async () => {
    const h = harness();
    const { receiptId } = await h.deleteEvent();
    expect((await h.undo('calendar-delete-undo', receiptId, at(3))).kind).toBe('preview');
    const view = await h.flow.find(h.session());
    const task = h.tasks.get(view?.taskId as string) as Task;
    const anchor = task.metadata?.connectorWriteAnchor as { undoOf: Record<string, unknown> } & Record<string, unknown>;
    h.tasks.set(task.id, { ...task, metadata: { ...task.metadata, connectorWriteAnchor: { ...anchor, undoOf: { ...anchor.undoOf, receiptId: 'another-receipt' } } } });
    expect(reason(await h.approveAndExecute(at(4)))).toBe('binding-mismatch');
    expect(h.writes.restore).toHaveLength(0);
  });
});
