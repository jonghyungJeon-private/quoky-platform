import { describe, expect, it } from 'vitest';
import { ApprovalStatus, SessionStatus } from '../../domain';
import type { Actor, ApprovalRequest, Session, Task } from '../../domain';
import type { CalendarEvent, CalendarReader } from '../../ports/calendar-reader.port';
import {
  connectorWriteSent,
  type CalendarEventCreateRequest,
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
import type { TurnHandlerContext, TurnHandlerWriteDraft } from '../../ports/conversation-turn-handler.port';
import { createCalendarTurnHandler } from '../calendar/calendar-turn-handler';
import { renderConnectorWriteStep } from './connector-write-copy';
import type { ConnectorWriteDraft } from './connector-write-draft';
import { StatelessConnectorWriteFlow, type ConnectorWriteStep } from './connector-write-flow';

// Live QA session 3, D2: "일정 취소해줘" (no day, no time, no title) right after creating or listing tomorrow's event
// offered TODAY's real event as the only match. The real calendar handler (grammar + per-session last list) and the
// real StatelessConnectorWriteFlow; storage, approvals, receipts, the writer and the reader are in-memory fakes.

const SEOUL = 'Asia/Seoul';
/** Tuesday 2026-10-06 10:00 Asia/Seoul. */
const T0 = '2026-10-06T01:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const OWNER: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };

/** Today 14:00 KST: the owner's real weekly meeting (the event QA saw offered by mistake). */
const TODAY_WEEKLY: CalendarEvent = {
  id: 'evt-today-weekly',
  title: '플랫폼 엔지니어링 파트 Weekly',
  start: '2026-10-06T05:00:00.000Z',
  end: '2026-10-06T06:00:00.000Z',
  allDay: false,
  status: 'confirmed',
  calendarName: 'primary',
  version: '"v-weekly"',
};
/** Tomorrow 09:00 KST. */
const TOMORROW_STANDUP: CalendarEvent = {
  ...TODAY_WEEKLY,
  id: 'evt-tomorrow-standup',
  title: '스탠드업',
  start: '2026-10-07T00:00:00.000Z',
  end: '2026-10-07T00:30:00.000Z',
  version: '"v-standup"',
};
/** Friday: outside today and tomorrow. */
const FRIDAY_REVIEW: CalendarEvent = {
  ...TODAY_WEEKLY,
  id: 'evt-friday',
  title: '분기 리뷰',
  start: '2026-10-09T05:00:00.000Z',
  end: '2026-10-09T06:00:00.000Z',
  version: '"v-friday"',
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
    const data = outcome.status === 'SENT' ? { externalRef: outcome.externalRef } : { reason: outcome.reason };
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
        .filter((row) => row.status === 'SENT' && row.operation === match.operation && row.target === match.target && row.payloadSha256 === match.payloadSha256)
        .pop() ?? null
    );
  }
  async findLatestForOperation(): Promise<ConnectorWriteReceipt | null> {
    return null;
  }
  async markInterruptedPreparedUncertain(): Promise<number> {
    return 0;
  }
}

function harness(initial: CalendarEvent[]) {
  const live = { events: [...initial] };
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, Task>();
  const approvals = new Map<string, ApprovalRequest>();
  const reads: Array<{ from: string; to: string }> = [];
  const writes = { create: [] as CalendarEventCreateRequest[], delete: [] as CalendarEventDeleteRequest[] };
  const context = { platform: 'test', channelId: 'chan-1', userId: 'owner-user' };
  sessions.set('sess-1', { id: 'sess-1', actorId: OWNER.id, context, status: SessionStatus.ACTIVE, createdAt: T0, lastActivityAt: T0 });
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
      listByContext: async (channelId: string, threadId?: string) =>
        [...tasks.values()].filter((task) => task.context.channelId === channelId && task.context.threadId === threadId),
    },
  };
  const reader: CalendarReader = {
    source: 'calendar',
    readOnly: true,
    async listEvents(query) {
      reads.push({ from: query.from, to: query.to });
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      return live.events.filter((event) => Date.parse(event.end) > from && Date.parse(event.start) < to);
    },
  };
  const writer: CalendarEventWriter = {
    source: 'calendar',
    target: 'primary',
    async createEvent(request) {
      writes.create.push(request);
      const time = request.draft.time;
      if (!time.allDay) {
        live.events.push({
          id: 'evt-created',
          title: request.draft.title,
          start: time.start,
          end: time.end,
          allDay: false,
          status: 'confirmed',
          calendarName: 'primary',
          version: '"v-created"',
        });
      }
      return connectorWriteSent('evt-created');
    },
    async updateEvent(request) {
      return connectorWriteSent(request.eventId);
    },
    async deleteEvent(request) {
      writes.delete.push(request);
      return connectorWriteSent(request.eventId);
    },
  };
  let seq = 0;
  const flow = new StatelessConnectorWriteFlow({
    writers: { calendarEvents: writer },
    calendarReader: reader,
    receipts: new MemoryReceipts(),
    approvals: {
      async requestForRisk(input) {
        const approval: ApprovalRequest = {
          id: `appr-${++seq}`,
          executionPlanRef: input.executionPlanRef,
          status: ApprovalStatus.PENDING,
          riskLevel: input.riskLevel,
          reason: input.reason,
          requestedBy: input.requestedBy,
          createdAt: T0,
        };
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
  const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL, writesEnabled: true });
  const session = (): Session => sessions.get('sess-1') as Session;
  const ctx = (text: string, now: string, actor: Actor): TurnHandlerContext => ({
    message: { id: `m-${++seq}`, context, text, receivedAt: now },
    session: session(),
    actor,
    now,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  });

  /** One calendar turn: a read reply's text, or the write draft handed to the flow and the flow's step. */
  async function turn(
    text: string,
    now: string,
    actor: Actor = OWNER,
  ): Promise<{ draft?: ConnectorWriteDraft; step?: ConnectorWriteStep; text: string }> {
    const outcome = await handler.handle(ctx(text, now, actor));
    if (!outcome) throw new Error(`not claimed: ${text}`);
    if (outcome.kind !== 'write-draft') {
      return { text: 'reply' in outcome ? outcome.reply.text : '' };
    }
    const draft = (outcome as TurnHandlerWriteDraft).draft;
    const step = await flow.prepare({ session: session(), actor, now, draft });
    return { draft, step, text: step.kind === 'writes-off' ? '' : renderConnectorWriteStep(step) };
  }

  /** "승인" then the execution phrase for the session's pending preview (the runtime's part, minus its copy). */
  async function approveAndExecute(now: string): Promise<ConnectorWriteStep> {
    const pending = await flow.find(session());
    if (!pending?.approval) throw new Error('no pending approval');
    // The runtime decides the approval through ApprovalManager, then records it on the anchor it found.
    approvals.set(pending.approval.id, { ...pending.approval, status: ApprovalStatus.APPROVED });
    await flow.recordApproval({ session: session(), actor: OWNER, now, view: pending });
    const view = await flow.find(session());
    return flow.execute({ session: session(), actor: OWNER, now, view: view as NonNullable<typeof view> });
  }

  async function choose(index: number, now: string): Promise<ConnectorWriteStep> {
    const view = await flow.find(session());
    if (!view) throw new Error('no choice pending');
    return flow.choose({ session: session(), actor: OWNER, now, view, index });
  }

  return { turn, approveAndExecute, choose, reads, writes, live };
}

const ids = (step: ConnectorWriteStep | undefined): string[] => (step?.kind === 'choice' ? step.candidates.map((c) => c.id) : []);

describe('undated calendar change / delete uses the session\'s recent calendar context (live QA D2)', () => {
  it('the QA repro: create tomorrow → list tomorrow → "일정 취소해줘" offers tomorrow\'s listed events, never today\'s', async () => {
    const h = harness([TODAY_WEEKLY, TOMORROW_STANDUP]);
    const created = await h.turn('내일 오후 5시에 "QA 세션3" 일정 잡아줘', at(0));
    expect(created.step?.kind).toBe('preview');
    expect((await h.approveAndExecute(at(1))).kind).toBe('outcome');
    expect(h.writes.create).toHaveLength(1);

    const listed = await h.turn('내일 일정 뭐야?', at(2));
    expect(listed.text).toContain('QA 세션3');

    const cancel = await h.turn('일정 취소해줘', at(3));
    expect(cancel.draft).toMatchObject({ kind: 'calendar-delete', ref: { inferredDay: true, recentListing: { eventIds: ['evt-tomorrow-standup', 'evt-created'] } } });
    expect(cancel.step).toMatchObject({ kind: 'choice', mode: 'delete', basis: 'listed' });
    expect(ids(cancel.step)).toEqual(['evt-tomorrow-standup', 'evt-created']);
    expect(ids(cancel.step)).not.toContain(TODAY_WEEKLY.id);
    expect(cancel.text).toContain('방금 보여 드린 일정');
    expect(cancel.text).toContain('아직 캘린더를 바꾸지 않았어요.');

    // Picking a number previews exactly that event; nothing is deleted before 승인 + the phrase.
    const picked = await h.choose(2, at(4));
    expect(picked).toMatchObject({ kind: 'preview', preview: { operation: 'CALENDAR_EVENT_DELETE', before: { id: 'evt-created' } } });
    expect(h.writes.delete).toHaveLength(0);
  });

  it('right after a create (no list in between) the just-created event is the only candidate — still a numbered choice', async () => {
    const h = harness([TODAY_WEEKLY]);
    await h.turn('내일 오후 5시에 "QA 세션3" 일정 잡아줘', at(0));
    await h.approveAndExecute(at(1));
    const cancel = await h.turn('일정 취소해줘', at(2));
    expect(cancel.step).toMatchObject({ kind: 'choice', basis: 'written' });
    expect(ids(cancel.step)).toEqual(['evt-created']);
    expect(cancel.text).toContain('방금 추가·변경한 일정');
  });

  it('the newer context wins: a create after a list targets the created event', async () => {
    const h = harness([TODAY_WEEKLY, TOMORROW_STANDUP]);
    await h.turn('오늘 일정', at(0));
    await h.turn('내일 오후 5시에 "QA 세션3" 일정 잡아줘', at(1));
    await h.approveAndExecute(at(2));
    const cancel = await h.turn('일정 취소해줘', at(3));
    expect(cancel.step).toMatchObject({ kind: 'choice', basis: 'written' });
    expect(ids(cancel.step)).toEqual(['evt-created']);
  });

  it('with no context it asks over today AND tomorrow (start order), never today alone', async () => {
    const h = harness([TOMORROW_STANDUP, TODAY_WEEKLY, FRIDAY_REVIEW]);
    const cancel = await h.turn('일정 취소해줘', at(0));
    expect(cancel.step).toMatchObject({ kind: 'choice', basis: 'nearby' });
    expect(ids(cancel.step)).toEqual([TODAY_WEEKLY.id, TOMORROW_STANDUP.id]);
    expect(h.reads.at(-1)).toEqual({ from: '2026-10-05T15:00:00.000Z', to: '2026-10-07T15:00:00.000Z' });
    expect(cancel.text).toContain('오늘·내일 일정');
  });

  it('even a single nearby event is offered as a choice, never previewed directly', async () => {
    const h = harness([TODAY_WEEKLY]);
    const cancel = await h.turn('일정 삭제해줘', at(0));
    expect(cancel.step).toMatchObject({ kind: 'choice', basis: 'nearby' });
    expect(ids(cancel.step)).toEqual([TODAY_WEEKLY.id]);
  });

  it('no context and nothing today or tomorrow is a truthful refusal (no approval)', async () => {
    const h = harness([FRIDAY_REVIEW]);
    const cancel = await h.turn('일정 취소해줘', at(0));
    expect(cancel.step).toMatchObject({ kind: 'refused', reason: 'no-nearby-events' });
    expect(cancel.text).toContain('이 요청으로는 캘린더를 바꾸지 않았어요.');
  });

  it('a list older than 30 minutes is not context any more', async () => {
    const h = harness([TODAY_WEEKLY, TOMORROW_STANDUP, FRIDAY_REVIEW]);
    await h.turn('금요일 일정', at(0));
    const fresh = await h.turn('일정 취소해줘', at(29));
    expect(fresh.step).toMatchObject({ kind: 'choice', basis: 'listed' });
    expect(ids(fresh.step)).toEqual([FRIDAY_REVIEW.id]);
    const stale = await h.turn('일정 취소해줘', at(31));
    expect(stale.step).toMatchObject({ kind: 'choice', basis: 'nearby' });
    expect(ids(stale.step)).not.toContain(FRIDAY_REVIEW.id);
  });

  it('an empty last list falls back to the today-and-tomorrow choice', async () => {
    const h = harness([TODAY_WEEKLY]);
    await h.turn('금요일 일정', at(0));
    const cancel = await h.turn('일정 취소해줘', at(1));
    expect(cancel.step).toMatchObject({ kind: 'choice', basis: 'nearby' });
  });

  it('an undated move with a time matches the listed event at that time of day', async () => {
    const h = harness([TODAY_WEEKLY, TOMORROW_STANDUP]);
    await h.turn('내일 일정', at(0));
    const move = await h.turn('9시 회의 10시로 옮겨줘', at(1));
    expect(move.step).toMatchObject({ kind: 'choice', mode: 'update', basis: 'listed' });
    expect(ids(move.step)).toEqual([TOMORROW_STANDUP.id]);
  });

  it('one actor\'s last list is never another actor\'s context in a shared conversation (Codex P2)', async () => {
    const h = harness([TODAY_WEEKLY, TOMORROW_STANDUP, FRIDAY_REVIEW]);
    const guest: Actor = { id: 'guest', displayName: 'Guest', identities: [], createdAt: T0 };
    await h.turn('금요일 일정', at(0), guest);
    const owner = await h.turn('일정 취소해줘', at(1));
    expect(owner.draft).toMatchObject({ kind: 'calendar-delete', ref: { inferredDay: true } });
    expect(owner.draft?.kind === 'calendar-delete' && owner.draft.ref.recentListing).toBeUndefined();
    expect(owner.step).toMatchObject({ kind: 'choice', basis: 'nearby' });
    expect(ids(owner.step)).not.toContain(FRIDAY_REVIEW.id);
    // The guest's own list is still theirs.
    const own = await h.turn('일정 취소해줘', at(2), guest);
    expect(own.step).toMatchObject({ kind: 'choice', basis: 'listed' });
    expect(ids(own.step)).toEqual([FRIDAY_REVIEW.id]);
  });

  it('with no context an undated time or title is matched over today AND tomorrow, still as a choice (Codex P2)', async () => {
    const h = harness([TODAY_WEEKLY, TOMORROW_STANDUP]);
    const timed = await h.turn('9시 회의 취소해줘', at(0));
    expect(timed.draft).toMatchObject({ ref: { inferredDay: true, startTime: { hour: 9, minute: 0 } } });
    expect(timed.step).toMatchObject({ kind: 'choice', basis: 'nearby' });
    expect(ids(timed.step)).toEqual([TOMORROW_STANDUP.id]);
    const titled = await h.turn('"스탠드업" 일정 취소해줘', at(1));
    expect(ids(titled.step)).toEqual([TOMORROW_STANDUP.id]);
    const none = await h.turn('11시 회의 취소해줘', at(2));
    expect(none.step).toMatchObject({ kind: 'refused', reason: 'event-not-found' });
  });

  it('a named day keeps the existing reference behaviour (no basis, that day only)', async () => {
    const h = harness([TODAY_WEEKLY, TOMORROW_STANDUP]);
    await h.turn('내일 일정', at(0));
    const today = await h.turn('오늘 일정 취소해줘', at(1));
    expect(today.step).toMatchObject({ kind: 'choice' });
    expect(today.step?.kind === 'choice' && today.step.basis).toBeUndefined();
    expect(ids(today.step)).toEqual([TODAY_WEEKLY.id]);
    const timed = await h.turn('내일 9시 회의 취소해줘', at(2));
    expect(timed.step).toMatchObject({ kind: 'preview', preview: { before: { id: TOMORROW_STANDUP.id } } });
  });
});
