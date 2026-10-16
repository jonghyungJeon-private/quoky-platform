import { describe, expect, it } from 'vitest';
import {
  REMINDER_LIMITS,
  type ActionWriteCondition,
  ReminderStatus,
  cancelReminder,
  type ConversationContext,
  type Reminder,
  type ReminderDraft,
} from '../../domain';
import type {
  CancelReminderResult,
  CompleteFiringResult,
  CreateReminderResult,
  ReactivateReminderResult,
  ReminderRepository,
} from '../../ports/reminder-repository.port';
import type { Logger } from '../../ports/logger.port';
import type { CalendarEvent, CalendarEventQuery } from '../../ports/calendar-reader.port';
import { plainTextOf } from '../message-rendering';
import type { NlSelectedCommand } from '../nl-routing/catalog';
import { ReminderConversationService } from './reminder-conversation-service';
import { ReminderReplyComposer } from './reminder-reply-composer';

// ADR-0120 amendment A6 (NLA-3): natural-language reminder actions and their per-action inverses (ratification record
// A), the undo-only reactivation through the one additive CAS method, and unchanged anchored replies with receipts.

const CONTEXT: ConversationContext = { platform: 'discord', channelId: 'c1', userId: 'owner', direct: true };
const ACTOR = 'actor-1';
const NOW = '2026-10-14T03:00:00.000Z'; // Wed 12:00 KST
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class MemoryRepository implements ReminderRepository {
  readonly rows: Reminder[] = [];
  private nextNo = 13;
  /** The actor's persisted switch, read atomically with each conditional write (as the SQLite adapter does). */
  stopped = false;
  private blocked(condition?: ActionWriteCondition): boolean {
    return condition !== undefined && this.stopped;
  }
  async createWithinLimit(draft: ReminderDraft, maxActive: number, condition?: ActionWriteCondition): Promise<CreateReminderResult> {
    if (this.blocked(condition)) return { status: 'STOPPED' };
    const active = this.rows.filter((r) => r.actorId === draft.actorId && (r.status === ReminderStatus.SCHEDULED || r.status === ReminderStatus.FIRING));
    if (active.length >= maxActive) return { status: 'LIMIT_REACHED', activeCount: active.length };
    const reminder: Reminder = { ...draft, displayNo: this.nextNo++ };
    this.rows.push(reminder);
    return { status: 'CREATED', reminder };
  }
  async listByActorStatuses(actorId: string, statuses: readonly ReminderStatus[]): Promise<Reminder[]> {
    return this.rows.filter((r) => r.actorId === actorId && statuses.includes(r.status)).sort((a, b) => a.displayNo - b.displayNo);
  }
  async listActiveByActor(actorId: string): Promise<Reminder[]> {
    return this.rows.filter((r) => r.actorId === actorId && (r.status === ReminderStatus.SCHEDULED || r.status === ReminderStatus.FIRING));
  }
  async getByDisplayNo(actorId: string, displayNo: number): Promise<Reminder | null> {
    return this.rows.find((r) => r.actorId === actorId && r.displayNo === displayNo) ?? null;
  }
  async cancel(actorId: string, displayNo: number, at: string, condition?: ActionWriteCondition): Promise<CancelReminderResult> {
    if (this.blocked(condition)) return { status: 'STOPPED' };
    const index = this.rows.findIndex((r) => r.actorId === actorId && r.displayNo === displayNo);
    const row = this.rows[index];
    if (row === undefined) return { status: 'NOT_FOUND' };
    if (row.status === ReminderStatus.FIRING) return { status: 'IN_FLIGHT', reminder: row };
    if (row.status !== ReminderStatus.SCHEDULED) return { status: 'ALREADY_FINAL', reminder: row };
    const canceled = cancelReminder(row, at);
    this.rows[index] = canceled;
    return { status: 'CANCELED', reminder: canceled };
  }
  async reactivate(actorId: string, next: Reminder, expectedUpdatedAt: string, maxActive: number, condition?: ActionWriteCondition): Promise<ReactivateReminderResult> {
    if (this.blocked(condition)) return { status: 'STOPPED' };
    const index = this.rows.findIndex((r) => r.id === next.id && r.actorId === actorId);
    const row = this.rows[index];
    if (row === undefined) return { status: 'NOT_FOUND' };
    if (row.status !== ReminderStatus.CANCELED || row.updatedAt !== expectedUpdatedAt) return { status: 'CHANGED', reminder: row };
    const active = (await this.listActiveByActor(actorId)).length;
    if (active >= maxActive) return { status: 'LIMIT_REACHED', activeCount: active };
    this.rows[index] = next;
    return { status: 'REACTIVATED', reminder: next };
  }
  async claimDue(): Promise<Reminder[]> {
    return [];
  }
  async completeFiring(): Promise<CompleteFiringResult> {
    return { status: 'CONFLICT' };
  }
  async listFiring(): Promise<Reminder[]> {
    return [];
  }
}

function service(actionReceipts = true, events?: () => CalendarEvent[]) {
  const repository = new MemoryRepository();
  const conversation = new ReminderConversationService({
    repository,
    composer: new ReminderReplyComposer(),
    timeZone: 'Asia/Seoul',
    enabled: true,
    logger: silent,
    actionReceipts,
    ...(events !== undefined ? { calendar: { listEvents: async (_query: CalendarEventQuery) => events() } } : {}),
    idGenerator: (() => {
      let n = 0;
      return () => `rem-${++n}`;
    })(),
  });
  return { repository, conversation };
}

const base = (now = NOW) => ({ context: CONTEXT, actorId: ACTOR, messageId: 'm1', now });
const cmd = (entryId: NlSelectedCommand['entryId'], args: NlSelectedCommand['args'] = {}, extra: Partial<NlSelectedCommand> = {}): NlSelectedCommand => ({ entryId, args, language: 'ko', ...extra });
const text = (result: { reply: { text: string; content?: unknown } }) => plainTextOf((result.reply.content as never) ?? result.reply.text);

describe('anchored reminder commands keep their replies and only gain receipts', () => {
  it('create, list and cancel: same text; receipts only with actionReceipts', async () => {
    const on = service(true);
    const off = service(false);
    const create = { ...base(), text: '내일 9시에 물 마시기 알려줘' };
    const a = await on.conversation.handleTurnDetailed(create);
    const b = await off.conversation.handleTurnDetailed(create);
    expect(a?.reply.text).toBe(b?.reply.text);
    expect(a?.action).toMatchObject({ entryId: 'reminder.create', source: 'reminder', label: 13 });
    expect(b?.action).toBeUndefined();
    expect((await on.conversation.handleTurnDetailed({ ...base(), text: '알림 목록' }))?.listing).toEqual({ source: 'reminder', items: [{ label: 13, id: 'rem-1' }] });
    expect((await on.conversation.handleTurnDetailed({ ...base(), text: '알림 13 취소' }))?.action).toMatchObject({ entryId: 'reminder.cancel', label: 13 });
    expect(await on.conversation.handleTurn({ ...base(), text: '알림 목록' })).toEqual((await on.conversation.handleTurnDetailed({ ...base(), text: '알림 목록' }))?.reply);
  });
});

describe('A6 reminder actions', () => {
  it('reminder.create parses `when` with the deterministic grammar and echoes #N, the absolute time and the undo hint', async () => {
    const { conversation, repository } = service();
    const result = await conversation.handleAction(cmd('reminder.create', { body: '물 마시기', when: '내일 9시' }), base());
    expect(text(result)).toMatch(/^알림 #13을 만들었어요: 10월 15일\(목\) 오전 9:00 · '물 마시기' · 되돌리려면 "되돌려줘" \(10분 안\)$/u);
    expect(repository.rows[0]).toMatchObject({ body: '물 마시기', schedule: { type: 'ONCE' }, nextFireAt: '2026-10-15T00:00:00.000Z' });
    const unclear = await conversation.handleAction(cmd('reminder.create', { body: '물', when: '회의' }), base());
    expect(unclear.action).toMatchObject({ result: 'refused', reason: 'when-unparsed' });
  });

  it('reminder.cancel by display number; a target id that does not match refuses', async () => {
    const { conversation } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '물 마시기', when: '내일 9시' }), base());
    expect((await conversation.handleAction(cmd('reminder.cancel', { ref: 'recent' }, { target: { source: 'reminder', id: 'other', label: 13 } }), base())).action).toMatchObject({ result: 'refused' });
    const canceled = await conversation.handleAction(cmd('reminder.cancel', { ref: '#13' }, { target: { source: 'reminder', label: 13 } }), base());
    expect(text(canceled)).toContain('알림 #13 취소했어요');
    expect(canceled.action).toMatchObject({ entryId: 'reminder.cancel', result: 'executed', itemId: 'rem-1', label: 13 });
  });
});

describe('owner decision C (2026-10-17, A6-D1 amendment): reminder.cancel by title', () => {
  const byTitle = (match: string) => cmd('reminder.cancel', { match });

  it('exactly one scheduled match is canceled with the receipt and the undo hint; "되돌려줘" schedules the SAME #N again', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '치과 예약 확인', when: '내일 9시' }), base());
    await conversation.handleAction(cmd('reminder.create', { body: '세무사 통화', when: '내일 10시' }), base());
    const canceled = await conversation.handleAction(byTitle('치과  예약 확인'), base());
    expect(text(canceled)).toBe('알림 #13 취소했어요: \'치과 예약 확인\' · 되돌리려면 "되돌려줘" (10분 안)');
    expect(canceled.action).toMatchObject({ entryId: 'reminder.cancel', result: 'executed', itemId: 'rem-1', label: 13, undoable: true });
    expect(repository.rows.map((row) => row.status)).toEqual([ReminderStatus.CANCELED, ReminderStatus.SCHEDULED]);
    const undo = await conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel', version: canceled.action?.version as string } }), base());
    expect(undo.action).toMatchObject({ result: 'undone', undoOf: 'reminder.cancel', itemId: 'rem-1', label: 13 });
    expect(repository.rows).toHaveLength(2);
    expect(repository.rows[0]).toMatchObject({ id: 'rem-1', displayNo: 13, status: ReminderStatus.SCHEDULED });
  });

  it('several scheduled matches ask with each candidate under its #N; nothing changes', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '약 먹기', when: '내일 9시' }), base());
    await conversation.handleAction(cmd('reminder.create', { body: '세무사 통화', when: '내일 10시' }), base());
    await conversation.handleAction(cmd('reminder.create', { body: '약 먹기', when: '매일 저녁 8시' }), base());
    const asked = await conversation.handleAction(byTitle('약 먹기'), base());
    expect(text(asked)).toContain('어느 알림인가요? 번호로 답해 주세요. 아직 아무것도 바꾸지 않았어요.');
    expect(text(asked)).toContain('#13 10월 15일(목) 오전 9:00 약 먹기');
    expect(text(asked)).toContain('#15 ');
    expect(text(asked)).not.toContain('#14');
    expect(asked.action).toEqual({ entryId: 'reminder.cancel', result: 'asked', source: 'reminder', reason: 'ambiguous', candidates: [{ label: 13, id: 'rem-1' }, { label: 15, id: 'rem-3' }] });
    expect(repository.rows.every((row) => row.status === ReminderStatus.SCHEDULED)).toBe(true);
  });

  it('counter-cases: delivered or cancelled reminders never match and a part of a body is no match; nothing changes', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '치과 예약 확인', when: '내일 9시' }), base());
    await conversation.handleAction(cmd('reminder.create', { body: '세무사 통화', when: '내일 10시' }), base());
    await conversation.handleAction(cmd('reminder.create', { body: '서류 제출', when: '내일 11시' }), base());
    repository.rows[0] = { ...(repository.rows[0] as Reminder), status: ReminderStatus.COMPLETED };
    repository.rows[1] = cancelReminder(repository.rows[1] as Reminder, NOW);
    const before = JSON.stringify(repository.rows);
    for (const match of ['치과 예약 확인', '세무사 통화', '서류', '서류 제출하기']) {
      const result = await conversation.handleAction(byTitle(match), base());
      expect(text(result), match).toBe('그 내용의 예정된 알림을 찾지 못했어요. 아무것도 바꾸지 않았어요. "알림 목록"에서 번호를 확인해 주세요.');
      expect(result.action, match).toEqual({ entryId: 'reminder.cancel', result: 'refused', source: 'reminder', reason: 'not-found' });
    }
    expect(JSON.stringify(repository.rows)).toBe(before);
    // The one scheduled match still cancels.
    expect((await conversation.handleAction(byTitle('서류 제출'), base())).action).toMatchObject({ result: 'executed', label: 15 });
  });

  it('a FIRING copy with the same text is not a candidate: the one SCHEDULED reminder is cancelled, not asked', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '약 먹기', when: '내일 9시' }), base());
    await conversation.handleAction(cmd('reminder.create', { body: '약 먹기', when: '내일 10시' }), base());
    repository.rows[0] = { ...(repository.rows[0] as Reminder), status: ReminderStatus.FIRING };
    const result = await conversation.handleAction(byTitle('약 먹기'), base());
    expect(result.action).toMatchObject({ entryId: 'reminder.cancel', result: 'executed', itemId: 'rem-2', label: 14 });
    expect(repository.rows.map((row) => row.status)).toEqual([ReminderStatus.FIRING, ReminderStatus.CANCELED]);
  });
});

describe('reminder inverses (ratification record A)', () => {
  it('reminder.create → cancel it; a one-shot that already fired → "이미 알림이 나갔어요"', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '물 마시기', when: '내일 9시' }), base());
    const undo = await conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.create' } }), base());
    expect(undo.action).toMatchObject({ result: 'undone', undoOf: 'reminder.create', undoable: false });
    expect(repository.rows[0]?.status).toBe(ReminderStatus.CANCELED);
    await conversation.handleAction(cmd('reminder.create', { body: '약', when: '내일 10시' }), base());
    repository.rows[1] = { ...(repository.rows[1] as Reminder), status: ReminderStatus.COMPLETED };
    const fired = await conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-2', label: 14 }, undo: { entryId: 'reminder.create' } }), base());
    expect(text(fired)).toBe('이미 알림이 나갔어요. 되돌릴 게 없어요.');
  });

  it('reminder.cancel → the SAME reminder (same #N) is scheduled again; a recurring one resumes from its next occurrence', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '약 먹기', when: '매일 아침 8시' }), base());
    const canceled = await conversation.handleAction(cmd('reminder.cancel', { ref: '#13' }, { target: { source: 'reminder', label: 13 } }), base());
    const version = canceled.action?.version as string;
    // Two days later: missed occurrences are never sent; it resumes from the next 08:00 after now.
    const later = '2026-10-16T05:00:00.000Z';
    const undo = await conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel', version } }), base(later));
    expect(undo.action).toMatchObject({ result: 'undone', undoOf: 'reminder.cancel', label: 13 });
    expect(repository.rows[0]).toMatchObject({ id: 'rem-1', displayNo: 13, status: ReminderStatus.SCHEDULED, schedule: { type: 'DAILY' }, nextFireAt: '2026-10-16T23:00:00.000Z' });
    expect(text(undo)).toContain('알림 #13을 다시 켰어요');
  });

  it('a one-shot whose time passed asks for a new time (reminder id only); the answer reschedules the same #N', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '스트레칭', when: '30분 뒤' }), base());
    const canceled = await conversation.handleAction(cmd('reminder.cancel', { ref: '#13' }, { target: { source: 'reminder', label: 13 } }), base());
    const late = '2026-10-14T04:00:00.000Z';
    const ask = await conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel', version: canceled.action?.version as string } }), base(late));
    expect(ask.action).toMatchObject({ result: 'reschedule', itemId: 'rem-1', label: 13, reason: 'past-time', version: canceled.action?.version });
    expect(text(ask)).toBe('알림 #13의 시간이 이미 지났어요. 언제 다시 알려 드릴까요?');
    // The answer carries the cancel's version: no version, or another one, is a lost compare-and-set.
    const unversioned = await conversation.handleAction(cmd('action.undo', { when: '내일 9시' }, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel' } }), base(late));
    expect(unversioned.action).toMatchObject({ result: 'refused', reason: 'changed' });
    const answered = await conversation.handleAction(cmd('action.undo', { when: '내일 9시' }, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel', version: ask.action?.version as string } }), base(late));
    expect(answered.action).toMatchObject({ result: 'undone', label: 13 });
    expect(repository.rows[0]).toMatchObject({ displayNo: 13, status: ReminderStatus.SCHEDULED, schedule: { type: 'ONCE', at: '2026-10-15T00:00:00.000Z' } });
  });

  it('a CAS lost to a concurrent change and the active limit are said plainly', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '물', when: '내일 9시' }), base());
    await conversation.handleAction(cmd('reminder.cancel', { ref: '#13' }, { target: { source: 'reminder', label: 13 } }), base());
    const stale = await conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel', version: '2000-01-01T00:00:00.000Z' } }), base());
    expect(stale.action).toMatchObject({ result: 'refused', reason: 'changed' });
    const version = repository.rows[0]?.updatedAt as string;
    for (let i = 0; i < REMINDER_LIMITS.maxActivePerActor; i += 1) {
      repository.rows.push({ ...(repository.rows[0] as Reminder), id: `fill-${i}`, displayNo: 100 + i, status: ReminderStatus.SCHEDULED });
    }
    const limited = await conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel', version } }), base());
    expect(limited.action).toMatchObject({ result: 'refused', reason: 'limit' });
  });
});

describe('event-relative reminders (CA review P2)', () => {
  const event = (start: string): CalendarEvent => ({ id: 'evt-1', title: '주간 회의', start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), allDay: false, status: 'confirmed', calendarName: '기본' });

  it('the NL path keeps the owner\'s words as the body; the anchored BRF-2 grammar keeps the event title', async () => {
    const start = '2026-10-15T01:00:00.000Z';
    const { conversation, repository } = service(true, () => [event(start)]);
    const created = await conversation.handleAction(cmd('reminder.create', { body: '자료 출력', when: '주간 회의 10분 전' }), base());
    expect(created.action).toMatchObject({ result: 'executed' });
    expect(repository.rows[0]).toMatchObject({ body: '자료 출력', event: { eventId: 'evt-1', offsetMinutes: 10 } });
    await conversation.handleTurn({ ...base(), text: '주간 회의 10분 전에 알려줘' });
    expect(repository.rows[1]?.body).toBe('주간 회의');
  });

  it('undoing the cancel of a future event-relative reminder re-checks the event: moved or gone is said, nothing reactivates', async () => {
    const start = '2026-10-15T01:00:00.000Z';
    let events = [event(start)];
    const { conversation, repository } = service(true, () => events);
    await conversation.handleAction(cmd('reminder.create', { body: '자료 출력', when: '주간 회의 10분 전' }), base());
    const canceled = await conversation.handleAction(cmd('reminder.cancel', { ref: '#13' }, { target: { source: 'reminder', label: 13 } }), base());
    const undo = () => conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel', version: canceled.action?.version as string } }), base());
    events = [event('2026-10-15T03:00:00.000Z')];
    expect((await undo()).action).toMatchObject({ result: 'refused', reason: 'event-moved' });
    events = [];
    expect((await undo()).action).toMatchObject({ result: 'refused', reason: 'event-gone' });
    expect(repository.rows[0]?.status).toBe(ReminderStatus.CANCELED);
    events = [event(start)];
    expect((await undo()).action).toMatchObject({ result: 'undone' });
    expect(repository.rows[0]?.status).toBe(ReminderStatus.SCHEDULED);
  });
});

describe('a selector-chosen reminder list records the listing as rendered (CA review P1)', () => {
  it('listReplyDetailed reports the rows shown, capped at what the budget rendered', async () => {
    const { conversation, repository } = service();
    for (let i = 0; i < 3; i += 1) await conversation.handleAction(cmd('reminder.create', { body: `알림 ${i}`, when: '내일 9시' }), base());
    expect((await conversation.listReplyDetailed(base())).listing).toEqual({ source: 'reminder', items: [{ label: 13, id: 'rem-1' }, { label: 14, id: 'rem-2' }, { label: 15, id: 'rem-3' }] });
    repository.rows[0] = { ...(repository.rows[0] as Reminder), status: ReminderStatus.COMPLETED };
    expect((await conversation.listReplyDetailed(base())).listing?.items.map((item) => item.label)).toEqual([14, 15]);
    for (let i = 0; i < 40; i += 1) {
      await conversation.handleAction(cmd('reminder.create', { body: '아주 긴 알림 본문입니다 '.repeat(8).trim().slice(0, 190), when: '내일 10시' }), base());
    }
    const many = await conversation.listReplyDetailed(base());
    const shown = new ReminderReplyComposer().listRendered(await repository.listActiveByActor(ACTOR), NOW).shown;
    expect(shown).toBeLessThan(42);
    expect(many.listing?.items).toHaveLength(shown);
    const off = service(false);
    expect((await off.conversation.listReplyDetailed(base())).listing).toBeUndefined();
  });
});


describe('the kill switch is atomic with every reminder write (Codex round 3, A6-D3)', () => {
  const condition = { actionSwitchOf: ACTOR };

  it('a stop persisted while the calendar lookup is pending prevents the event reminder create', async () => {
    let release: () => void = () => undefined;
    const repository = new MemoryRepository();
    const start = '2026-10-15T01:00:00.000Z';
    const conversation = new ReminderConversationService({
      repository,
      composer: new ReminderReplyComposer(),
      timeZone: 'Asia/Seoul',
      enabled: true,
      logger: silent,
      actionReceipts: true,
      calendar: {
        listEvents: () =>
          new Promise<CalendarEvent[]>((resolve) => {
            release = () => resolve([{ id: 'evt-1', title: '주간 회의', start, end: '2026-10-15T02:00:00.000Z', allDay: false, status: 'confirmed', calendarName: '기본' }]);
          }),
      },
    });
    const pendingCreate = conversation.handleAction(cmd('reminder.create', { body: '자료 출력', when: '주간 회의 10분 전' }), { ...base(), actionCondition: condition });
    await new Promise((resolve) => setTimeout(resolve, 5));
    repository.stopped = true;
    release();
    expect((await pendingCreate).action).toMatchObject({ result: 'refused', reason: 'stopped' });
    expect(repository.rows).toHaveLength(0);
  });

  it('the stopped reply follows the turn language on every reminder write (CA P3)', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '물', when: '내일 9시' }), base());
    await conversation.handleTurn({ ...base(), text: '알림 13 취소' });
    const version = repository.rows[0]?.updatedAt as string;
    repository.stopped = true;
    const stop = { ...base(), actionCondition: condition };
    const en = { language: 'en' as const };
    const results = [
      await conversation.handleAction(cmd('reminder.create', { body: '약', when: '내일 10시' }, en), stop),
      await conversation.handleAction(cmd('reminder.create', { body: '약', when: '내일 10시' }), stop),
      await conversation.handleAction(cmd('action.undo', {}, { ...en, target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel', version } }), stop),
    ];
    expect(results.map((result) => text(result))).toEqual([
      'Natural-language actions are stopped, so I did nothing. Exact commands still work.',
      '자연어 실행이 멈춰 있어서 아무것도 하지 않았어요. 정확한 명령은 그대로 동작해요.',
      'Natural-language actions are stopped, so I did nothing. Exact commands still work.',
    ]);
  });

  it('create, cancel, undo-create (cancel) and undo-cancel (reactivate): the write carries the condition; anchored writes do not', async () => {
    const { conversation, repository } = service();
    await conversation.handleAction(cmd('reminder.create', { body: '물', when: '내일 9시' }), base());
    const stop = { ...base(), actionCondition: condition };
    repository.stopped = true;
    expect((await conversation.handleAction(cmd('reminder.create', { body: '약', when: '내일 10시' }), stop)).action).toMatchObject({ reason: 'stopped' });
    expect((await conversation.handleAction(cmd('reminder.cancel', { ref: '#13' }, { target: { source: 'reminder', label: 13 } }), stop)).action).toMatchObject({ reason: 'stopped' });
    expect((await conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.create' } }), stop)).action).toMatchObject({ reason: 'stopped' });
    expect(repository.rows.map((row) => row.status)).toEqual([ReminderStatus.SCHEDULED]);
    // An anchored command carries no condition: it still works while the switch is stopped.
    await conversation.handleTurn({ ...base(), text: '알림 13 취소' });
    expect(repository.rows[0]?.status).toBe(ReminderStatus.CANCELED);
    const version = repository.rows[0]?.updatedAt as string;
    expect((await conversation.handleAction(cmd('action.undo', {}, { target: { source: 'reminder', id: 'rem-1', label: 13 }, undo: { entryId: 'reminder.cancel', version } }), stop)).action).toMatchObject({ reason: 'stopped' });
    expect(repository.rows[0]?.status).toBe(ReminderStatus.CANCELED);
  });
});

// A6-D2 amendment (2026-10-16) regression guard: the to-do snapshot rule does not touch reminders. A reminder's `#N` is
// its stable, never-reused display number, so a list that changed since it was shown never renumbers a reminder.
describe('anchored reminder numbers stay stable when the list changes (A6-D2 amendment guard)', () => {
  it('after #13 fired, "알림 14 취소" still cancels the reminder shown as #14, and "알림 13 취소" changes nothing', async () => {
    const { conversation, repository } = service();
    for (const text of ['내일 9시에 물 마시기 알려줘', '내일 10시에 약 먹기 알려줘', '내일 11시에 스트레칭 알려줘']) {
      await conversation.handleTurnDetailed({ ...base(), text });
    }
    const listed = await conversation.handleTurnDetailed({ ...base(), text: '알림 목록' });
    expect(listed?.listing?.items).toEqual([
      { label: 13, id: 'rem-1' },
      { label: 14, id: 'rem-2' },
      { label: 15, id: 'rem-3' },
    ]);
    repository.rows[0] = { ...(repository.rows[0] as Reminder), status: ReminderStatus.COMPLETED };
    const canceled = await conversation.handleTurnDetailed({ ...base(), text: '알림 14 취소' });
    expect(canceled?.action).toMatchObject({ entryId: 'reminder.cancel', result: 'executed', itemId: 'rem-2', label: 14 });
    expect(repository.rows.map((row) => [row.displayNo, row.status])).toEqual([
      [13, ReminderStatus.COMPLETED],
      [14, ReminderStatus.CANCELED],
      [15, ReminderStatus.SCHEDULED],
    ]);
    const fired = await conversation.handleTurnDetailed({ ...base(), text: '알림 13 취소' });
    expect(fired?.action?.result).not.toBe('executed');
    expect(repository.rows[0]?.status).toBe(ReminderStatus.COMPLETED);
    expect((await conversation.handleTurnDetailed({ ...base(), text: '알림 목록' }))?.listing?.items).toEqual([{ label: 15, id: 'rem-3' }]);
  });
});
