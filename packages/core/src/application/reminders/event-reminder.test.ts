import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  InvalidReminderError,
  InvalidReminderTransitionError,
  ReminderStatus,
  applyFiringCompletion,
  cancelReminder,
  claimReminder,
  createReminderDraft,
  planEventCanceledCompletion,
  planEventRescheduleCompletion,
  type ConversationContext,
  type Reminder,
  type ReminderDraft,
  type ReminderFiringCompletion,
} from '../../domain';
import type { CalendarEvent, CalendarEventQuery } from '../../ports/calendar-reader.port';
import { ConnectorQueryError } from '../../ports/connector-query';
import type { Logger, LogFields } from '../../ports/logger.port';
import type { NotificationSink, OwnerNotification } from '../../ports/notification-sink.port';
import type {
  CancelReminderResult,
  CompleteFiringResult,
  CreateReminderResult,
  ReminderRepository,
} from '../../ports/reminder-repository.port';
import { PLAIN_TEXT_MARKUP, renderMessageContent } from '../message-rendering';
import type { MessageMarkup } from '../../ports/message-markup.port';
import { EventReminderCalendar, eventTitleKey, resolveEventReminderTarget } from './event-reminder-calendar';
import { parseEventReminder } from './event-reminder-grammar';
import { ReminderConversationService } from './reminder-conversation-service';
import { ReminderDispatchService } from './reminder-dispatch-service';
import { parseReminderMessage } from './reminder-grammar';
import { ReminderReplyComposer, eventReminderStoredTitle } from './reminder-reply-composer';
import { ReminderTurnHandler, REMINDER_EVENT_HISTORY_NOTE } from './reminder-turn-handler';

const ZONE = 'Asia/Seoul';
const ACTOR = 'actor-1';
const ORIGIN: ConversationContext = { platform: 'telegram', channelId: 'dm-1', userId: 'owner', direct: true };
// 2026-10-09 10:00 KST (Friday).
const NOW = '2026-10-09T01:00:00.000Z';
const MINUTE = 60_000;
const at = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * MINUTE).toISOString();

function event(id: string, title: string, start: string, durationMinutes = 60, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, title, start, end: at(start, durationMinutes), allDay: false, status: 'confirmed', calendarName: 'primary', ...extra };
}

function allDayEvent(id: string, title: string, date: string, endDate: string): CalendarEvent {
  return { id, title, start: date, end: endDate, allDay: true, status: 'confirmed', calendarName: 'primary' };
}

/** A fake calendar: the events (filtered by window overlap, ordered, limited) or a failure. Records every query. */
class FakeCalendar {
  readonly queries: CalendarEventQuery[] = [];
  events: CalendarEvent[];
  fail: 'error' | 'hang' | undefined;
  constructor(events: CalendarEvent[] = []) {
    this.events = events;
  }
  async listEvents(query: CalendarEventQuery): Promise<readonly CalendarEvent[]> {
    this.queries.push(query);
    if (this.fail === 'error') throw new ConnectorQueryError('UNAVAILABLE', 'calendar: down');
    if (this.fail === 'hang') return new Promise(() => undefined);
    const fromMs = Date.parse(query.from);
    const toMs = Date.parse(query.to);
    const startOf = (e: CalendarEvent): number => (e.allDay ? Date.parse(`${e.start}T00:00:00+09:00`) : Date.parse(e.start));
    const endOf = (e: CalendarEvent): number => (e.allDay ? Date.parse(`${e.end}T00:00:00+09:00`) : Date.parse(e.end));
    return this.events
      .filter((e) => startOf(e) < toMs && endOf(e) > fromMs)
      .sort((a, b) => startOf(a) - startOf(b))
      .slice(0, query.limit ?? 50);
  }
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
  warn(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
  error(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
}

/** In-memory repository with the SQLite repository's compare-and-set semantics (pure domain transitions). */
class FakeRepository implements ReminderRepository {
  readonly rows = new Map<string, Reminder>();
  private nextNo = 1;
  async createWithinLimit(draft: ReminderDraft, maxActive: number): Promise<CreateReminderResult> {
    const active = [...this.rows.values()].filter((r) => r.status === ReminderStatus.SCHEDULED || r.status === ReminderStatus.FIRING);
    if (active.length >= maxActive) return { status: 'LIMIT_REACHED', activeCount: active.length };
    const reminder: Reminder = { ...draft, displayNo: this.nextNo++ };
    this.rows.set(reminder.id, reminder);
    return { status: 'CREATED', reminder };
  }
  async listActiveByActor(actorId: string): Promise<Reminder[]> {
    return [...this.rows.values()]
      .filter((r) => r.actorId === actorId && (r.status === ReminderStatus.SCHEDULED || r.status === ReminderStatus.FIRING))
      .sort((a, b) => a.displayNo - b.displayNo);
  }
  async getByDisplayNo(actorId: string, displayNo: number): Promise<Reminder | null> {
    return [...this.rows.values()].find((r) => r.actorId === actorId && r.displayNo === displayNo) ?? null;
  }
  async cancel(actorId: string, displayNo: number, when: string): Promise<CancelReminderResult> {
    const row = await this.getByDisplayNo(actorId, displayNo);
    if (!row) return { status: 'NOT_FOUND' };
    if (row.status === ReminderStatus.FIRING) return { status: 'IN_FLIGHT', reminder: row };
    if (row.status !== ReminderStatus.SCHEDULED) return { status: 'ALREADY_FINAL', reminder: row };
    const canceled = cancelReminder(row, when);
    this.rows.set(row.id, canceled);
    return { status: 'CANCELED', reminder: canceled };
  }
  async claimDue(now: string, limit: number, attemptId: string): Promise<Reminder[]> {
    const due = [...this.rows.values()]
      .filter((r) => r.status === ReminderStatus.SCHEDULED && r.nextFireAt !== undefined && Date.parse(r.nextFireAt) <= Date.parse(now))
      .slice(0, limit);
    return due.map((r) => {
      const claimed = claimReminder(r, attemptId, now);
      this.rows.set(r.id, claimed);
      return claimed;
    });
  }
  async completeFiring(id: string, attemptId: string, completion: ReminderFiringCompletion): Promise<CompleteFiringResult> {
    const row = this.rows.get(id);
    if (!row || row.status !== ReminderStatus.FIRING || row.firingAttemptId !== attemptId) return { status: 'CONFLICT' };
    const next = applyFiringCompletion(row, attemptId, completion);
    this.rows.set(id, next);
    return { status: 'COMPLETED', reminder: next };
  }
  async listFiring(): Promise<Reminder[]> {
    return [...this.rows.values()].filter((r) => r.status === ReminderStatus.FIRING);
  }
}

class FakeSink implements NotificationSink {
  readonly delivered: OwnerNotification[] = [];
  outcomes: Array<Awaited<ReturnType<NotificationSink['deliver']>>> = [];
  async deliver(notification: OwnerNotification) {
    this.delivered.push(notification);
    return this.outcomes.shift() ?? ({ status: 'SENT', via: 'dm' } as const);
  }
}

/** Escapes every character of an untrusted span (stands in for a markup platform). */
const BRACKETING_MARKUP: MessageMarkup = { ...PLAIN_TEXT_MARKUP, untrusted: (text) => `⟦${text}⟧` };

function plain(body: OwnerNotification | { text: string; content?: unknown }): string {
  return body.text;
}

function harness(events: CalendarEvent[] = [], options: { calendar?: boolean; timeZone?: string } = {}) {
  const calendar = new FakeCalendar(events);
  const repository = new FakeRepository();
  const composer = new ReminderReplyComposer();
  const sink = new FakeSink();
  const logger = new RecordingLogger();
  let ids = 0;
  const withCalendar = options.calendar !== false;
  const conversation = new ReminderConversationService({
    repository,
    composer,
    timeZone: options.timeZone ?? ZONE,
    enabled: true,
    logger,
    idGenerator: () => `rem-${++ids}`,
    ...(withCalendar ? { calendar, calendarTimeoutMs: 50 } : {}),
  });
  const dispatch = new ReminderDispatchService({
    repository,
    sink,
    composer,
    workItems: { listByActor: async () => [] },
    logger,
    idGenerator: () => `attempt-${++ids}`,
    ...(withCalendar ? { eventCalendar: new EventReminderCalendar({ reader: calendar, logger, recheckTimeoutMs: 50 }) } : {}),
  });
  const say = async (text: string, now = NOW) =>
    conversation.handleTurn({ text, context: ORIGIN, actorId: ACTOR, messageId: 'm1', now });
  return { calendar, repository, composer, sink, logger, conversation, dispatch, say };
}

// Fixture day (KST): 11:00 주간 회의, 15:00 디자인 리뷰, 15:00 코드 리뷰, tomorrow 09:00 주간 회의, an all-day 워크숍.
const WEEKLY = event('ev-weekly', '주간 회의', '2026-10-09T02:00:00.000Z'); // 11:00 KST
const DESIGN = event('ev-design', '디자인 리뷰', '2026-10-09T06:00:00.000Z'); // 15:00 KST
const CODE = event('ev-code', '코드 리뷰', '2026-10-09T06:00:00.000Z'); // 15:00 KST
const WEEKLY_TOMORROW = event('ev-weekly-2', '주간 회의', '2026-10-10T00:00:00.000Z'); // 10-10 09:00 KST
const WORKSHOP = allDayEvent('ev-workshop', '전사 워크숍', '2026-10-12', '2026-10-13');

describe('event-relative grammar (ADR-0117 D5)', () => {
  const cases: Array<[string, number, object]> = [
    ['회의 10분 전에 알려줘', 10, {}],
    ['다음 회의 30분 전에 알려줘', 30, {}],
    ['3시 회의 15분 전에 알려줘', 15, { time: { hour: 3, minute: 0 } }],
    ['오후 3시 회의 15분 전에 알려줘', 15, { time: { hour: 3, minute: 0, meridiem: 'pm' } }],
    ['내일 9시 반 회의 10분 전에 알려 줘', 10, { dayOffset: 1, time: { hour: 9, minute: 30 } }],
    ['주간 회의 10분 전에 알려줘', 10, { title: '주간' }],
    ['디자인 리뷰 회의 1시간 전에 리마인드 해줘', 60, { title: '디자인 리뷰' }],
    ['내 다음 미팅 1시간 30분 전에 알림 줘', 90, {}],
    ['내일 회의 두 시간 전에 알려주세요', 120, { dayOffset: 1 }],
    ['오늘 3시 디자인 리뷰 회의 시작 5분 전에 알려줘.', 5, { dayOffset: 0, time: { hour: 3, minute: 0 }, title: '디자인 리뷰' }],
    ['내부 회의 10분 전에 알려줘', 10, { title: '내부' }],
    ['금요일 주간 회의 20분 전에 알려줘', 20, { weekday: 5, title: '주간' }],
    ['remind me 10 minutes before my next meeting', 10, {}],
    ['Remind me 15 minutes before the 3pm meeting', 15, { time: { hour: 3, minute: 0, meridiem: 'pm' } }],
    ['remind me 10 minutes before the design review meeting', 10, { title: 'design review' }],
    ['please remind me an hour before my 9:30 call tomorrow', 60, { dayOffset: 1, time: { hour: 9, minute: 30, clock24: true } }],
    ['내일 03:00 회의 10분 전에 알려줘', 10, { dayOffset: 1, time: { hour: 3, minute: 0, clock24: true } }],
    ['15:00 회의 10분 전에 알려줘', 10, { time: { hour: 15, minute: 0, clock24: true } }],
  ];
  for (const [text, offsetMinutes, target] of cases) {
    it(`"${text}" → CREATE_EVENT_RELATIVE`, () => {
      expect(parseEventReminder(text)).toMatchObject({ kind: 'create', offsetMinutes, target });
      expect(parseReminderMessage(text, { now: NOW, timeZone: ZONE })).toEqual({
        kind: 'CREATE_EVENT_RELATIVE',
        offsetMinutes,
        target,
      });
    });
  }

  it('offsets outside 1-120 minutes and a missing offset clarify', () => {
    for (const text of ['회의 0분 전에 알려줘', '회의 3시간 전에 알려줘', '회의 121분 전에 알려줘', 'remind me 3 hours before my next meeting']) {
      expect(parseReminderMessage(text, { now: NOW, timeZone: ZONE })).toEqual({ kind: 'CLARIFY', reason: 'EVENT_OFFSET_OUT_OF_RANGE' });
    }
    for (const text of ['회의 전에 알려줘', '다음 회의 시작 전에 알려줘', 'remind me before my next meeting']) {
      expect(parseReminderMessage(text, { now: NOW, timeZone: ZONE })).toEqual({ kind: 'CLARIFY', reason: 'EVENT_OFFSET_MISSING' });
    }
  });

  it('leaves everything else to the ADR-0101 grammar unchanged', () => {
    const others = [
      '회의 10분 전에 안 알려줘',
      '회의 10분 전에 알려줘?',
      '회의 10분 전에 자료 준비 알려줘',
      '30분 뒤에 스트레칭 알려줘',
      '내일 오전 9시에 회의 준비 알려줘',
      '회의록 10분 전에 정리했어',
      '다음 회의 언제야?',
      '다음 주 회의 10분 전에 알려줘',
      '10월 20일 회의 10분 전에 알려줘',
    ];
    for (const text of others) expect(parseEventReminder(text).kind).toBe('none');
    expect(parseReminderMessage('30분 뒤에 스트레칭 알려줘', { now: NOW, timeZone: ZONE }).kind).toBe('CREATE');
    expect(parseReminderMessage('할 일 추가: 회의 10분 전에 알려줘', { now: NOW, timeZone: ZONE }).kind).toBe('NOT_REMINDER');
  });
});

describe('recurrence and a bound clock time stay with the ADR-0101 grammar (Codex P2-3)', () => {
  const legacy = (text: string) => parseReminderMessage(text, { now: NOW, timeZone: ZONE, eventRelative: false });
  const current = (text: string) => parseReminderMessage(text, { now: NOW, timeZone: ZONE });

  it('`매일 오전 9시에 회의 10분 전에 알려줘` is still the daily 09:00 reminder it always was', () => {
    expect(current('매일 오전 9시에 회의 10분 전에 알려줘')).toEqual({
      kind: 'CREATE',
      body: '회의 10분 전에',
      bodyKind: 'TEXT',
      schedule: { type: 'DAILY', time: { hour: 9, minute: 0 } },
      firstFireAt: '2026-10-10T00:00:00.000Z',
      timeZone: ZONE,
    });
  });

  it('recurrence and clock-time variants keep their pre-BRF-2 outcome', () => {
    const variants = [
      '평일 9시에 회의 10분 전에 알려줘',
      '매주 월요일 오전 10시에 회의 15분 전에 알려줘',
      '내일 오전 9시에 회의 10분 전에 알려줘',
      '오후 3시 30분에 회의 10분 전에 알려줘',
      '30분 뒤에 회의 10분 전에 알려줘',
      '매일 회의 10분 전에 알려줘',
      '매일 회의 전에 알려줘',
      '주말마다 회의 10분 전에 알려줘',
      'remind me 10 minutes before my daily standup meeting',
      'remind me 10 minutes before every meeting',
    ];
    for (const text of variants) {
      expect(current(text), text).toEqual(legacy(text));
      expect(current(text).kind, text).not.toBe('CREATE_EVENT_RELATIVE');
    }
    expect(current('평일 9시에 회의 10분 전에 알려줘')).toMatchObject({ kind: 'CREATE', schedule: { type: 'WEEKLY' } });
    expect(current('30분 뒤에 회의 10분 전에 알려줘')).toMatchObject({ kind: 'CREATE', schedule: { type: 'ONCE' } });
  });

  it('a start time that only names the meeting is still event-relative', () => {
    for (const text of ['3시 회의 15분 전에 알려줘', '내일 9시 반 회의 10분 전에 알려 줘', '15:00 회의 10분 전에 알려줘']) {
      expect(current(text).kind, text).toBe('CREATE_EVENT_RELATIVE');
    }
  });
});

describe('negation, addressee and question guards apply to the whole message (Codex P2-4)', () => {
  const legacy = (text: string) => parseReminderMessage(text, { now: NOW, timeZone: ZONE, eventRelative: false });
  const current = (text: string) => parseReminderMessage(text, { now: NOW, timeZone: ZONE });

  it('`알림 없이 회의 10분 전에 알려줘` stays NOT_REMINDER, and so does every form the ADR-0101 grammar refuses', () => {
    const refused = [
      '알림 없이 회의 10분 전에 알려줘',
      '알림 말고 회의 10분 전에 알려줘',
      '회의 10분 전에 알려주지 마',
      '회의 10분 전에 안 알려줘',
      '회의 10분 전에 알려줄 필요 없어',
      '다음 회의 10분 전에는 알려주지 말고 30분 전에 알려줘',
      '김대리한테 회의 10분 전에 알려줘',
      '팀원들에게 다음 회의 30분 전에 알려줘',
      '뭐 회의 10분 전에 알려줘',
      '언제 회의 10분 전에 알려줘',
      '어떤 회의 10분 전에 알려줘',
      "don't remind me 10 minutes before my next meeting",
      'never remind me 10 minutes before my next meeting',
      'you forgot to remind me 10 minutes before my next meeting',
      'no need to remind me 10 minutes before my next meeting',
      'remind me 10 minutes before my next meeting without fail',
    ];
    for (const text of refused) {
      expect(current(text), text).toEqual(legacy(text));
      expect(current(text).kind, text).not.toBe('CREATE_EVENT_RELATIVE');
    }
    expect(current('알림 없이 회의 10분 전에 알려줘')).toEqual({ kind: 'NOT_REMINDER' });
    expect(current('김대리한테 회의 10분 전에 알려줘')).toEqual({ kind: 'NOT_REMINDER' });
  });

  it('the owner as addressee and plain titles still pass', () => {
    for (const text of ['나한테 회의 10분 전에 알려줘', '저에게 다음 회의 30분 전에 알려줘', '고객 미팅 10분 전에 알려줘']) {
      expect(current(text).kind, text).toBe('CREATE_EVENT_RELATIVE');
    }
  });
});

describe('event resolution (pure)', () => {
  const day = [WEEKLY, DESIGN, CODE, WEEKLY_TOMORROW, WORKSHOP];
  const opts = { now: NOW, timeZone: ZONE, offsetMinutes: 10 };

  it('"next" is the earliest timed event that has not started; all-day events are skipped', () => {
    const r = resolveEventReminderTarget(day, {}, opts);
    expect(r).toMatchObject({ kind: 'found', event: { id: 'ev-weekly' }, fireAt: '2026-10-09T01:50:00.000Z' });
  });

  it('a started event is not "next"', () => {
    const r = resolveEventReminderTarget(day, {}, { ...opts, now: '2026-10-09T02:30:00.000Z' });
    expect(r).toMatchObject({ kind: 'ambiguous' }); // 15:00 has two events
  });

  it('by time: a bare 3시 matches 15:00; two events at that start are ambiguous (deterministic order)', () => {
    const r = resolveEventReminderTarget(day, { time: { hour: 3, minute: 0 } }, opts);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates.map((e) => e.id)).toEqual(['ev-code', 'ev-design']);
  });

  it('by title: exact wins and the next occurrence is picked; partial over several titles is ambiguous', () => {
    expect(resolveEventReminderTarget(day, { title: '주간' }, opts)).toMatchObject({ kind: 'found', event: { id: 'ev-weekly' } });
    expect(resolveEventReminderTarget(day, { title: '디자인리뷰' }, opts)).toMatchObject({ kind: 'found', event: { id: 'ev-design' } });
    const partial = resolveEventReminderTarget(day, { title: '리뷰' }, opts);
    expect(partial.kind === 'ambiguous' && partial.candidates.map((e) => e.title)).toEqual(['코드 리뷰', '디자인 리뷰']);
    expect(resolveEventReminderTarget(day, { title: '코드 리뷰', time: { hour: 3, minute: 0 } }, opts)).toMatchObject({
      kind: 'found',
      event: { id: 'ev-code' },
    });
  });

  it('HH:MM is 24-hour and exact; a bare 3시 is either half; 오후 3시 is 15:00 (Codex P2-2)', () => {
    const tomorrow3am = event('ev-3am', '새벽 배포', '2026-10-09T18:00:00.000Z'); // 10-10 03:00 KST
    const tomorrow3pm = event('ev-3pm', '오후 회의', '2026-10-10T06:00:00.000Z'); // 10-10 15:00 KST
    const both = [tomorrow3am, tomorrow3pm];
    const pick = (text: string) => {
      const parsed = parseEventReminder(text);
      if (parsed.kind !== 'create') throw new Error(text);
      return resolveEventReminderTarget(both, parsed.target, opts);
    };
    expect(pick('내일 03:00 회의 10분 전에 알려줘')).toMatchObject({ kind: 'found', event: { id: 'ev-3am' } });
    expect(pick('내일 15:00 회의 10분 전에 알려줘')).toMatchObject({ kind: 'found', event: { id: 'ev-3pm' } });
    expect(pick('내일 오후 3시 회의 10분 전에 알려줘')).toMatchObject({ kind: 'found', event: { id: 'ev-3pm' } });
    expect(pick('내일 오전 3시 회의 10분 전에 알려줘')).toMatchObject({ kind: 'found', event: { id: 'ev-3am' } });
    // A bare 3시 is either half of the day: both match, at different starts, so the earliest is taken.
    expect(pick('내일 3시 회의 10분 전에 알려줘')).toMatchObject({ kind: 'found', event: { id: 'ev-3am' } });
    // Only a 15:00 event: `03:00` finds nothing, while `3시` still finds it.
    expect(resolveEventReminderTarget([tomorrow3pm], { dayOffset: 1, time: { hour: 3, minute: 0, clock24: true } }, opts)).toEqual({
      kind: 'none',
      partial: false,
    });
    expect(resolveEventReminderTarget([tomorrow3pm], { dayOffset: 1, time: { hour: 3, minute: 0 } }, opts)).toMatchObject({ kind: 'found' });
  });

  it('by day and time: tomorrow 9시 is the 09:00 event', () => {
    const r = resolveEventReminderTarget(day, { dayOffset: 1, time: { hour: 9, minute: 0 } }, opts);
    expect(r).toMatchObject({ kind: 'found', event: { id: 'ev-weekly-2' }, fireAt: '2026-10-09T23:50:00.000Z' });
  });

  it('by weekday: the nearest Saturday event', () => {
    expect(resolveEventReminderTarget(day, { weekday: 6 }, opts)).toMatchObject({ kind: 'found', event: { id: 'ev-weekly-2' } });
    expect(resolveEventReminderTarget(day, { weekday: 1 }, opts)).toMatchObject({ kind: 'all-day', event: { id: 'ev-workshop' } });
  });

  it('no match, all-day only, too soon', () => {
    expect(resolveEventReminderTarget(day, { title: '저녁 약속' }, opts)).toEqual({ kind: 'none', partial: false });
    expect(resolveEventReminderTarget(day, { title: '워크숍' }, opts)).toMatchObject({ kind: 'all-day', event: { id: 'ev-workshop' } });
    expect(resolveEventReminderTarget([event('soon', '곧', at(NOW, 8))], {}, opts)).toMatchObject({ kind: 'too-soon' });
    expect(resolveEventReminderTarget([event('ok', '곧', at(NOW, 11))], {}, opts)).toMatchObject({ kind: 'found', fireAt: at(NOW, 1) });
  });

  it('the same title at the same start on two calendars is one event, not a choice', () => {
    const copy = { ...WEEKLY, id: 'ev-weekly-copy', calendarName: 'team' };
    expect(resolveEventReminderTarget([copy, WEEKLY], {}, opts)).toMatchObject({ kind: 'found', event: { id: 'ev-weekly' } });
  });

  it('title keys ignore case, spaces and punctuation', () => {
    expect(eventTitleKey(' Design-Review  Meeting ')).toBe('designreviewmeeting');
  });

  it('DST (America/New_York, 2026-11-01): "tomorrow 9am" is 09:00 EST and the reminder is 30 minutes before', () => {
    const now = '2026-10-31T16:00:00.000Z'; // 12:00 EDT
    const nine = event('ny', 'Standup', '2026-11-01T14:00:00.000Z'); // 09:00 EST (UTC-5)
    const r = resolveEventReminderTarget([nine], { dayOffset: 1, time: { hour: 9, minute: 0, meridiem: 'am' } }, {
      now,
      timeZone: 'America/New_York',
      offsetMinutes: 30,
    });
    expect(r).toMatchObject({ kind: 'found', fireAt: '2026-11-01T13:30:00.000Z' });
  });
});

describe('domain: event reference and fire-time completions', () => {
  const base = {
    id: 'r1', actorId: ACTOR, kind: 'TEXT' as const, body: '주간 회의', timeZone: ZONE, origin: ORIGIN,
    schedule: { type: 'ONCE' as const, at: '2026-10-09T01:50:00.000Z' }, firstFireAt: '2026-10-09T01:50:00.000Z', createdAt: NOW,
  };

  it('validates the bounded reference (id, 1-120 minutes, ONCE TEXT only)', () => {
    expect(createReminderDraft({ ...base, event: { eventId: 'ev', offsetMinutes: 10 } }).event).toEqual({ eventId: 'ev', offsetMinutes: 10 });
    for (const event of [
      { eventId: '', offsetMinutes: 10 },
      { eventId: 'x'.repeat(1025), offsetMinutes: 10 },
      { eventId: 'a\nb', offsetMinutes: 10 },
      { eventId: 'ev', offsetMinutes: 0 },
      { eventId: 'ev', offsetMinutes: 121 },
      { eventId: 'ev', offsetMinutes: 1.5 },
    ]) {
      expect(() => createReminderDraft({ ...base, event })).toThrow(InvalidReminderError);
    }
    expect(() => createReminderDraft({ ...base, kind: 'BRIEF', event: { eventId: 'ev', offsetMinutes: 10 } })).toThrow(InvalidReminderError);
  });

  it('reschedule moves forward only; cancel ends CANCELED unless a confirmed retryable NOT_SENT has retries left', () => {
    const draft = createReminderDraft({ ...base, event: { eventId: 'ev', offsetMinutes: 10 } });
    const firing = claimReminder({ ...draft, displayNo: 1 }, 'a1', '2026-10-09T01:50:00.000Z');
    const moved = planEventRescheduleCompletion(firing, { at: '2026-10-09T01:50:00.000Z', occurrenceAt: '2026-10-09T02:50:00.000Z' });
    expect(applyFiringCompletion(firing, 'a1', moved)).toMatchObject({
      status: ReminderStatus.SCHEDULED,
      schedule: { type: 'ONCE', at: '2026-10-09T02:50:00.000Z' },
      nextFireAt: '2026-10-09T02:50:00.000Z',
      event: { eventId: 'ev', offsetMinutes: 10 },
    });
    expect(() => planEventRescheduleCompletion(firing, { at: '2026-10-09T01:50:00.000Z', occurrenceAt: '2026-10-09T01:40:00.000Z' })).toThrow(
      InvalidReminderTransitionError,
    );
    const sent = planEventCanceledCompletion(firing, { status: 'SENT', via: 'dm' }, { at: '2026-10-09T01:50:00.000Z' });
    expect(applyFiringCompletion(firing, 'a1', sent)).toMatchObject({ status: ReminderStatus.CANCELED, lastOutcome: { outcome: 'SENT' } });
    const uncertain = planEventCanceledCompletion(firing, { status: 'UNCERTAIN', reason: 'TIMEOUT' }, { at: NOW });
    expect(uncertain).toMatchObject({ status: ReminderStatus.CANCELED, lastOutcome: { outcome: 'DELIVERY_UNCERTAIN' } });
    const retry = planEventCanceledCompletion(firing, { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true }, { at: NOW });
    expect(retry.status).toBe(ReminderStatus.SCHEDULED);
    // A text reminder has no event: these plans refuse it.
    const { event: _omit, ...plainFiring } = firing;
    expect(() => planEventCanceledCompletion(plainFiring as Reminder, { status: 'SENT', via: 'dm' }, { at: NOW })).toThrow();
  });
});

describe('creation through the conversation service', () => {
  it('"회의 10분 전에 알려줘" picks the next meeting, stores its id and offset, and echoes the title as an untrusted span', async () => {
    const h = harness([WEEKLY, DESIGN, CODE]);
    const reply = await h.say('회의 10분 전에 알려줘');
    expect(reply?.text).toBe(
      "10월 9일(금) 오전 10:50에 알려드릴게요: 주간 회의 (오전 11:00 시작, 10분 전). 일정이 옮겨지면 알림도 따라 옮기고, 일정이 삭제되면 알림을 취소해요. (#1 · 취소: '알림 1 취소')",
    );
    expect(renderMessageContent(reply?.content ?? [], BRACKETING_MARKUP)).toContain('⟦주간 회의⟧');
    const [stored] = await h.repository.listActiveByActor(ACTOR);
    expect(stored).toMatchObject({
      kind: 'TEXT',
      body: '주간 회의',
      schedule: { type: 'ONCE', at: '2026-10-09T01:50:00.000Z' },
      event: { eventId: 'ev-weekly', offsetMinutes: 10, calendarName: 'primary' },
      origin: ORIGIN,
    });
    expect(h.calendar.queries).toEqual([{ from: NOW, to: '2026-10-23T01:00:00.000Z', limit: 50 }]);
  });

  it('each phrasing resolves its event', async () => {
    const phrasings: Array<[string, string, string]> = [
      ['다음 회의 30분 전에 알려줘', 'ev-weekly', '2026-10-09T01:30:00.000Z'],
      ['디자인 리뷰 회의 10분 전에 알려줘', 'ev-design', '2026-10-09T05:50:00.000Z'],
      ['주간 회의 10분 전에 알려줘', 'ev-weekly', '2026-10-09T01:50:00.000Z'],
      ['내일 9시 회의 15분 전에 알려줘', 'ev-weekly-2', '2026-10-09T23:45:00.000Z'],
      ['remind me 10 minutes before the 9am meeting tomorrow', 'ev-weekly-2', '2026-10-09T23:50:00.000Z'],
      ['remind me 15 minutes before my next meeting', 'ev-weekly', '2026-10-09T01:45:00.000Z'],
    ];
    for (const [text, id, fireAt] of phrasings) {
      const h = harness([WEEKLY, DESIGN, CODE, WEEKLY_TOMORROW]);
      await h.say(text);
      const [stored] = await h.repository.listActiveByActor(ACTOR);
      expect(stored?.event?.eventId, text).toBe(id);
      expect(stored?.nextFireAt, text).toBe(fireAt);
    }
  });

  it('ambiguity lists the candidates deterministically and creates nothing', async () => {
    const h = harness([WEEKLY, DESIGN, CODE]);
    const reply = await h.say('3시 회의 15분 전에 알려줘');
    expect(reply?.text).toBe(
      [
        '어느 일정인지 하나로 정할 수 없어 알림을 만들지 않았어요. 제목이나 시각을 붙여 다시 말씀해 주세요.',
        '- 10월 9일(금) 오후 3:00 코드 리뷰',
        '- 10월 9일(금) 오후 3:00 디자인 리뷰',
        '예: "오후 3시 주간 회의 10분 전에 알려줘"',
      ].join('\n'),
    );
    expect(h.repository.rows.size).toBe(0);
  });

  it('no match, all-day, too soon, no calendar and an unreadable calendar are answered honestly; nothing is created', async () => {
    const h = harness([WEEKLY, WORKSHOP]);
    expect((await h.say('저녁 약속 회의 10분 전에 알려줘'))?.text).toBe(
      '말씀하신 일정을 앞으로 14일 일정에서 찾지 못해 알림을 만들지 않았어요. "이번 주 일정"으로 일정을 확인해 보세요.',
    );
    expect((await h.say('워크숍 일정 10분 전에 알려줘'))?.text).toBe(
      '종일 일정(전사 워크숍)에는 몇 분 전 알림을 만들 수 없어요. 시각을 정해 말씀해 주세요. 예: "내일 오전 9시에 회의 준비 알려줘"',
    );
    expect((await h.say('회의 10분 전에 알려줘', '2026-10-09T01:55:00.000Z'))?.text).toContain(
      '주간 회의 일정이 오전 11:00에 시작해서 10분 전 알림 시각이 이미 지났거나',
    );
    const empty = harness([]);
    expect((await empty.say('회의 10분 전에 알려줘'))?.text).toBe(
      '앞으로 14일 일정에서 아직 시작하지 않은 시간 지정 일정을 찾지 못해 알림을 만들지 않았어요. "이번 주 일정"으로 일정을 확인해 보세요.',
    );
    const none = harness([WEEKLY], { calendar: false });
    expect((await none.say('회의 10분 전에 알려줘'))?.text).toContain('캘린더가 연결되어 있지 않아');
    const down = harness([WEEKLY]);
    down.calendar.fail = 'error';
    expect((await down.say('회의 10분 전에 알려줘'))?.text).toBe('캘린더를 읽지 못해 회의 전 알림을 만들지 않았어요. 잠시 후 다시 시도해 주세요.');
    down.calendar.fail = 'hang';
    expect((await down.say('회의 10분 전에 알려줘'))?.text).toContain('캘린더를 읽지 못해');
    for (const x of [h, empty, none, down]) expect(x.repository.rows.size).toBe(0);
  });

  it('a credential-shaped title is never stored or shown; logs carry no title or id', async () => {
    const secret = event('ev-secret', 'password: hunter2-very-secret', '2026-10-09T03:00:00.000Z');
    const h = harness([secret]);
    const reply = await h.say('회의 10분 전에 알려줘');
    expect(reply?.text).toContain('(제목 숨김)');
    expect(reply?.text).not.toContain('hunter2');
    expect([...h.repository.rows.values()][0]?.body).toBe('(제목 숨김)');
    expect(h.logger.lines.join('\n')).not.toMatch(/hunter2|ev-secret|주간/);
    expect(eventReminderStoredTitle('')).toBe('(제목 없음)');
  });

  it('`알림 목록` shows the event label and title (untrusted); `알림 N 취소` cancels without echoing the title', async () => {
    const h = harness([WEEKLY, DESIGN]);
    await h.say('30분 뒤에 스트레칭 알려줘');
    await h.say('디자인 리뷰 회의 10분 전에 알려줘');
    const list = await h.say('알림 목록');
    expect(list?.text).toBe(
      ['예정된 알림 2건', '#1 10월 9일(금) 오전 10:30 [1회] 스트레칭', '#2 10월 9일(금) 오후 2:50 [회의 10분 전] 디자인 리뷰'].join('\n'),
    );
    expect(renderMessageContent(list?.content ?? [], BRACKETING_MARKUP)).toContain('[회의 10분 전] ⟦디자인 리뷰⟧');
    expect((await h.say('알림 2 취소'))?.text).toBe('알림 #2 취소했어요: 회의 10분 전 알림');
    expect((await h.repository.getByDisplayNo(ACTOR, 2))?.status).toBe(ReminderStatus.CANCELED);
  });

  it('the turn handler keeps a fixed history note for replies that carry an event title', async () => {
    const h = harness([WEEKLY]);
    const handler = new ReminderTurnHandler({ conversation: h.conversation, composer: h.composer, enabled: true, logger: h.logger });
    const ctx = (text: string) =>
      ({ message: { id: 'm', text, context: ORIGIN, receivedAt: NOW }, actor: { id: ACTOR }, session: { id: 's' }, now: NOW }) as never;
    expect(await handler.handle(ctx('회의 10분 전에 알려줘'))).toMatchObject({ history: { assistant: REMINDER_EVENT_HISTORY_NOTE } });
    const plainReply = await handler.handle(ctx('30분 뒤에 스트레칭 알려줘'));
    expect(plainReply).not.toHaveProperty('history');
  });
});

describe('fire-time re-check (ADR-0117 D6)', () => {
  async function created(events: CalendarEvent[], text = '회의 10분 전에 알려줘') {
    const h = harness(events);
    await h.say(text);
    h.calendar.queries.length = 0;
    return h;
  }
  const DUE = '2026-10-09T01:50:00.000Z'; // 10:50 KST

  it('unchanged: delivered once at the due time with the current title, to the origin', async () => {
    const h = await created([WEEKLY]);
    expect((await h.dispatch.dispatchDue(at(DUE, -1))).claimed).toBe(0);
    h.calendar.events = [{ ...WEEKLY, title: '주간 회의 (3층)' }];
    const summary = await h.dispatch.dispatchDue(DUE);
    expect(summary).toMatchObject({ claimed: 1, delivered: 1, eventRescheduled: 0, eventCanceled: 0, eventUnverified: 0 });
    expect(h.sink.delivered).toHaveLength(1);
    expect(plain(h.sink.delivered[0]!)).toBe('알림 #1: 주간 회의 (3층) 일정이 오전 11:00에 시작해요. (10분 전 알림)');
    expect(h.sink.delivered[0]).toMatchObject({ target: ORIGIN, kind: 'TEXT' });
    expect(renderMessageContent(h.sink.delivered[0]!.content ?? [], BRACKETING_MARKUP)).toContain('⟦주간 회의 (3층)⟧');
    expect((await h.repository.getByDisplayNo(ACTOR, 1))?.status).toBe(ReminderStatus.COMPLETED);
    // The re-check reads around the expected start (11:00 KST ± 12 h) and the wide window, always both.
    expect(h.calendar.queries).toEqual([
      { from: '2026-10-08T14:00:00.000Z', to: '2026-10-09T14:00:00.000Z', limit: 50 },
      { from: '2026-10-08T01:50:00.000Z', to: '2026-11-08T01:50:00.000Z', limit: 50 },
    ]);
    expect((await h.dispatch.dispatchDue(at(DUE, 30))).claimed).toBe(0);
    expect(h.sink.delivered).toHaveLength(1);
  });

  it('moved later: rescheduled without sending at the stale time, then delivered once at the new time', async () => {
    const h = await created([WEEKLY]);
    h.calendar.events = [{ ...WEEKLY, start: '2026-10-09T05:00:00.000Z', end: '2026-10-09T06:00:00.000Z' }]; // 14:00
    const first = await h.dispatch.dispatchDue(DUE);
    expect(first).toMatchObject({ claimed: 1, delivered: 0, eventRescheduled: 1 });
    expect(h.sink.delivered).toHaveLength(0);
    const moved = await h.repository.getByDisplayNo(ACTOR, 1);
    expect(moved).toMatchObject({ status: ReminderStatus.SCHEDULED, nextFireAt: '2026-10-09T04:50:00.000Z', attempt: 0 });
    const list = await h.say('알림 목록', at(DUE, 1));
    expect(list?.text).toContain('#1 10월 9일(금) 오후 1:50 [회의 10분 전] 주간 회의');
    expect((await h.dispatch.dispatchDue(at(DUE, 60))).claimed).toBe(0);
    await h.dispatch.dispatchDue('2026-10-09T04:50:00.000Z');
    expect(h.sink.delivered.map(plain)).toEqual(['알림 #1: 주간 회의 일정이 오후 2:00에 시작해요. (10분 전 알림)']);
    expect((await h.repository.getByDisplayNo(ACTOR, 1))?.status).toBe(ReminderStatus.COMPLETED);
  });

  it('moved twice: follows each move once (the second move found at the first new due time)', async () => {
    const h = await created([WEEKLY]);
    h.calendar.events = [{ ...WEEKLY, start: '2026-10-09T03:00:00.000Z' }]; // 12:00
    await h.dispatch.dispatchDue(DUE);
    h.calendar.events = [{ ...WEEKLY, start: '2026-10-09T04:00:00.000Z' }]; // 13:00
    const second = await h.dispatch.dispatchDue('2026-10-09T02:50:00.000Z');
    expect(second.eventRescheduled).toBe(1);
    await h.dispatch.dispatchDue('2026-10-09T03:50:00.000Z');
    expect(h.sink.delivered.map(plain)).toEqual(['알림 #1: 주간 회의 일정이 오후 1:00에 시작해요. (10분 전 알림)']);
  });

  it('moved earlier: delivered once at the re-check, saying the event moved (and that it already started)', async () => {
    const h = await created([event('ev-late', '분기 리뷰', '2026-10-09T06:00:00.000Z')]); // 15:00 → due 14:50
    h.calendar.events = [event('ev-late', '분기 리뷰', '2026-10-09T05:30:00.000Z')]; // now 14:30
    await h.dispatch.dispatchDue('2026-10-09T05:50:00.000Z');
    expect(h.sink.delivered.map(plain)).toEqual(['알림 #1: 분기 리뷰 일정이 오후 2:30 시작으로 앞당겨졌어요. 이미 시작했어요. (10분 전 알림)']);
    expect((await h.repository.getByDisplayNo(ACTOR, 1))?.status).toBe(ReminderStatus.COMPLETED);
  });

  it('deleted or cancelled (not returned by the reader): canceled with one note to the owner', async () => {
    const h = await created([WEEKLY]);
    h.calendar.events = [];
    const summary = await h.dispatch.dispatchDue(DUE);
    expect(summary).toMatchObject({ delivered: 1, eventCanceled: 1 });
    expect(h.sink.delivered.map(plain)).toEqual([
      '알림 #1 취소: 주간 회의 일정을 캘린더에서 찾을 수 없어(삭제·취소됐거나 30일 넘게 옮겨졌어요) 회의 전 알림을 취소했어요.',
    ]);
    expect(await h.repository.getByDisplayNo(ACTOR, 1)).toMatchObject({ status: ReminderStatus.CANCELED, lastOutcome: { outcome: 'SENT' } });
    expect(h.calendar.queries).toHaveLength(2);
    expect(h.calendar.queries[1]).toEqual({ from: '2026-10-08T01:50:00.000Z', to: '2026-11-08T01:50:00.000Z', limit: 50 });
    expect((await h.dispatch.dispatchDue(at(DUE, 30))).claimed).toBe(0);
    expect((await h.say('알림 1 취소', at(DUE, 31)))?.text).toBe('알림 #1은 이미 취소됐어요.');
  });

  it('two calendars with the same event id: the reminder follows the event on its own calendar (Codex P2-1)', async () => {
    const h = await created([WEEKLY]);
    // The same id on another calendar, unmoved; the reminder's own event (on `primary`) moved to 14:00.
    const otherCalendarCopy = { ...WEEKLY, calendarName: 'team', title: '팀 주간 회의' };
    h.calendar.events = [otherCalendarCopy, { ...WEEKLY, start: '2026-10-09T05:00:00.000Z', end: '2026-10-09T06:00:00.000Z' }];
    const summary = await h.dispatch.dispatchDue(DUE);
    expect(summary).toMatchObject({ delivered: 0, eventRescheduled: 1 });
    expect(h.sink.delivered).toHaveLength(0);
    expect(await h.repository.getByDisplayNo(ACTOR, 1)).toMatchObject({
      status: ReminderStatus.SCHEDULED,
      nextFireAt: '2026-10-09T04:50:00.000Z',
    });
    await h.dispatch.dispatchDue('2026-10-09T04:50:00.000Z');
    expect(h.sink.delivered.map(plain)).toEqual(['알림 #1: 주간 회의 일정이 오후 2:00에 시작해요. (10분 전 알림)']);
  });

  it('two calendars sharing the id AND the name: ambiguous, delivered with the could-not-re-check note, never a guess', async () => {
    const h = await created([WEEKLY]);
    h.calendar.events = [WEEKLY, { ...WEEKLY, title: '다른 회의', start: '2026-10-09T05:00:00.000Z', end: '2026-10-09T06:00:00.000Z' }];
    const summary = await h.dispatch.dispatchDue(DUE);
    expect(summary).toMatchObject({ delivered: 1, eventUnverified: 1, eventRescheduled: 0 });
    expect(h.sink.delivered.map(plain)).toEqual([
      '알림 #1: 주간 회의 일정이 오전 11:00에 시작해요. (10분 전 알림) (캘린더를 다시 확인하지 못해 처음 확인한 시각 기준으로 알려드려요)',
    ]);
    expect(h.logger.lines.some((line) => line.includes('"reason":"duplicate"'))).toBe(true);
  });

  it('a reference stored without a calendar name matches the id alone; a duplicate is ambiguous', async () => {
    const h = await created([WEEKLY]);
    const [row] = [...h.repository.rows.values()];
    h.repository.rows.set(row!.id, { ...row!, event: { eventId: 'ev-weekly', offsetMinutes: 10 } });
    h.calendar.events = [WEEKLY, { ...WEEKLY, calendarName: 'team', start: '2026-10-09T05:00:00.000Z', end: '2026-10-09T06:00:00.000Z' }];
    await h.dispatch.dispatchDue(DUE);
    expect(plain(h.sink.delivered[0]!)).toContain('캘린더를 다시 확인하지 못해');
  });

  it('an event that became all-day is canceled with its own note', async () => {
    const h = await created([WEEKLY]);
    h.calendar.events = [{ ...WEEKLY, allDay: true, start: '2026-10-09', end: '2026-10-10' }];
    await h.dispatch.dispatchDue(DUE);
    expect(h.sink.delivered.map(plain)).toEqual(['알림 #1 취소: 주간 회의 일정이 종일 일정으로 바뀌어 회의 전 알림을 취소했어요.']);
    expect((await h.repository.getByDisplayNo(ACTOR, 1))?.status).toBe(ReminderStatus.CANCELED);
  });

  it('unreadable at fire time (failure, timeout, a full page without the event): delivered once with the note', async () => {
    for (const mode of ['error', 'hang', 'full'] as const) {
      const h = await created([WEEKLY]);
      if (mode === 'full') {
        h.calendar.events = Array.from({ length: 60 }, (_, i) => event(`busy-${i}`, `busy ${i}`, at('2026-10-09T00:00:00.000Z', i)));
      } else h.calendar.fail = mode;
      const summary = await h.dispatch.dispatchDue(DUE);
      expect(summary, mode).toMatchObject({ delivered: 1, eventUnverified: 1 });
      expect(h.sink.delivered.map(plain), mode).toEqual([
        '알림 #1: 주간 회의 일정이 오전 11:00에 시작해요. (10분 전 알림) (캘린더를 다시 확인하지 못해 처음 확인한 시각 기준으로 알려드려요)',
      ]);
      expect((await h.repository.getByDisplayNo(ACTOR, 1))?.status, mode).toBe(ReminderStatus.COMPLETED);
      h.calendar.fail = undefined;
      expect((await h.dispatch.dispatchDue(at(DUE, 30))).claimed, mode).toBe(0);
      expect(h.sink.delivered, mode).toHaveLength(1);
    }
  });

  it('an UNCERTAIN delivery is never retried; a confirmed retryable NOT_SENT retries and re-checks again', async () => {
    const h = await created([WEEKLY]);
    h.sink.outcomes = [{ status: 'UNCERTAIN', reason: 'TIMEOUT' }];
    await h.dispatch.dispatchDue(DUE);
    expect((await h.repository.getByDisplayNo(ACTOR, 1))?.status).toBe(ReminderStatus.DELIVERY_UNCERTAIN);
    await h.dispatch.dispatchDue(at(DUE, 30));
    expect(h.sink.delivered).toHaveLength(1);

    const r = await created([WEEKLY]);
    r.sink.outcomes = [{ status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true }];
    await r.dispatch.dispatchDue(DUE);
    expect((await r.repository.getByDisplayNo(ACTOR, 1))?.nextFireAt).toBe(at(DUE, 1));
    r.calendar.events = [];
    await r.dispatch.dispatchDue(at(DUE, 1));
    expect(r.sink.delivered.map(plain)[1]).toContain('회의 전 알림을 취소했어요');
    expect((await r.repository.getByDisplayNo(ACTOR, 1))?.status).toBe(ReminderStatus.CANCELED);
  });

  it('after downtime an unchanged event is delivered once with the late label', async () => {
    const h = await created([WEEKLY]);
    await h.dispatch.dispatchDue(at(DUE, 20));
    expect(plain(h.sink.delivered[0]!)).toBe('알림 #1: 주간 회의 일정이 오전 11:00에 시작해요. (10분 전 알림) (원래 오전 10:50 예정 — 늦게 전달됐어요)');
  });

  it('a FIRING event reminder found at startup is DELIVERY_UNCERTAIN and never resent (at most once across a restart)', async () => {
    const h = await created([WEEKLY]);
    await h.repository.claimDue(DUE, 10, 'crashed');
    const recovery = await h.dispatch.recoverInterrupted(at(DUE, 5));
    expect(recovery.recovered).toBe(1);
    await h.dispatch.dispatchDue(at(DUE, 6));
    expect(h.sink.delivered).toHaveLength(0);
    expect(h.calendar.queries).toHaveLength(0);
    expect((await h.repository.getByDisplayNo(ACTOR, 1))?.status).toBe(ReminderStatus.DELIVERY_UNCERTAIN);
  });

  it('with no calendar configured at fire time the reminder is delivered with the could-not-re-check note', async () => {
    const h = await created([WEEKLY]);
    const noCalendar = new ReminderDispatchService({
      repository: h.repository,
      sink: h.sink,
      composer: h.composer,
      workItems: { listByActor: async () => [] },
      logger: h.logger,
    });
    await noCalendar.dispatchDue(DUE);
    expect(plain(h.sink.delivered[0]!)).toContain('캘린더를 다시 확인하지 못해');
  });

  it('DST (America/New_York): the due time follows the event across the 2026-11-01 change', async () => {
    const nyNow = '2026-10-31T16:00:00.000Z';
    const nine = event('ny', 'Standup', '2026-11-01T14:00:00.000Z'); // 09:00 EST
    const h = harness([nine], { timeZone: 'America/New_York' });
    await h.say('내일 오전 9시 회의 30분 전에 알려줘', nyNow);
    const [stored] = await h.repository.listActiveByActor(ACTOR);
    expect(stored).toMatchObject({ timeZone: 'America/New_York', nextFireAt: '2026-11-01T13:30:00.000Z' });
    await h.dispatch.dispatchDue('2026-11-01T13:30:00.000Z');
    expect(plain(h.sink.delivered[0]!)).toBe('알림 #1: Standup 일정이 오전 9:00에 시작해요. (30분 전 알림)');
  });

  it('the brief lists an event reminder with its title as an untrusted span', async () => {
    const h = await created([event('ev-pm', '고객 미팅', '2026-10-09T09:00:00.000Z')]); // 18:00 KST
    const body = h.composer.brief({
      now: NOW,
      timeZone: ZONE,
      reminders: await h.repository.listActiveByActor(ACTOR),
      workItems: [],
    });
    const rendered = renderMessageContent(body, BRACKETING_MARKUP);
    expect(rendered).toContain('- 오후 5:50 ⟦고객 미팅⟧ (회의 10분 전, #1)');
  });
});

describe('boundaries', () => {
  it('no provider, tool, write or runtime import in the event-relative modules', () => {
    for (const file of ['event-reminder-grammar.ts', 'event-reminder-calendar.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/ai-provider|tool-provider|connector-provider|calendar-writer|conversation-runtime|@nestjs|discord|telegram|sqlite/iu);
    }
  });
});
