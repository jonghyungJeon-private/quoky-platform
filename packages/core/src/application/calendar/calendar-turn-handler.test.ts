import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, CalendarEventQuery, CalendarReader } from '../../ports/calendar-reader.port';
import { ConnectorQueryError } from '../../ports/connector-query';
import type { TurnHandlerContext } from '../../ports/conversation-turn-handler.port';
import {
  CALENDAR_HELP_LINES,
  CALENDAR_WRITE_HELP_LINES,
  CALENDAR_TURN_HANDLER_ID,
  CALENDAR_TURN_HANDLER_ORDER,
  createCalendarTurnHandler,
} from './calendar-turn-handler';
import { renderCalendarHistoryNote } from './calendar-reply-renderer';
import { parseCalendarQuestion } from './calendar-question';

/** Tuesday 2026-10-06 10:00 in Asia/Seoul. */
const NOW = '2026-10-06T01:00:00.000Z';
const SEOUL = 'Asia/Seoul';

function ctx(text: string): TurnHandlerContext {
  return {
    message: { id: 'm-1', context: { platform: 'discord', channelId: 'c-1', userId: 'u-1' }, text, receivedAt: NOW },
    session: {} as TurnHandlerContext['session'],
    actor: {} as TurnHandlerContext['actor'],
    now: NOW,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  };
}

function fakeReader(listEvents: (query: CalendarEventQuery) => Promise<readonly CalendarEvent[]>) {
  const calls: CalendarEventQuery[] = [];
  const reader: CalendarReader = {
    source: 'calendar',
    readOnly: true,
    listEvents: async (query) => {
      calls.push(query);
      return listEvents(query);
    },
  };
  return { reader, calls };
}

const MEETING: CalendarEvent = {
  id: 'e-1',
  title: '팀 회의',
  start: '2026-10-07T00:00:00.000Z',
  end: '2026-10-07T01:00:00.000Z',
  allDay: false,
  status: 'confirmed',
  calendarName: 'primary',
};

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('calendar turn handler (ADR-0110 D3–D6)', () => {
  it('is the pre-classify order-150 handler with one bounded help line whose examples it claims', () => {
    const { reader } = fakeReader(async () => []);
    const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL });
    expect([handler.id, handler.stage, handler.order]).toEqual([CALENDAR_TURN_HANDLER_ID, 'pre-classify', 150]);
    expect(CALENDAR_TURN_HANDLER_ORDER).toBe(150);
    expect(handler.helpLines).toEqual(CALENDAR_HELP_LINES);
    for (const line of CALENDAR_HELP_LINES) expect(Array.from(line).length).toBeLessThanOrEqual(120);
    const quoted = [...(CALENDAR_HELP_LINES[0] as string).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    expect(quoted.length).toBe(4);
    for (const phrase of quoted) expect(parseCalendarQuestion(phrase)?.kind, phrase).toBe('events');
  });

  it('answers tomorrow from the reader with the exact local-day window and keeps no event text in history', async () => {
    const { reader, calls } = fakeReader(async () => [MEETING]);
    const log = logger();
    const outcome = await createCalendarTurnHandler({ reader, timeZone: SEOUL, logger: log }).handle(ctx('내일 일정 뭐야?'));
    expect(calls).toEqual([{ from: '2026-10-06T15:00:00.000Z', to: '2026-10-07T15:00:00.000Z', limit: 50 }]);
    expect(outcome).toEqual({
      reply: {
        context: ctx('').message.context,
        text: '내일 · 10월 7일(수): 일정 1개\n- 09:00–10:00 팀 회의\n(Asia/Seoul 기준 · 캘린더 읽기 전용)',
        // PLT-0: the event title and zone are untrusted spans the platform renders (the plain text is above).
        content: expect.any(Array),
        replyToMessageId: 'm-1',
      },
      status: 'RESPONDED',
      history: { assistant: renderCalendarHistoryNote('ko') },
    });
    expect(JSON.stringify(outcome?.history)).not.toContain('팀 회의');
    // Never a `summarize` outcome: no provider (LOCAL or REMOTE) ever sees calendar text (ADR-0110 D4).
    expect((outcome as { kind?: string }).kind).toBeUndefined();
    // Logs carry no message or event text.
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toMatch(/팀 회의|내일 일정/);
  });

  it('answers this week, the next meeting and an English question', async () => {
    const { reader, calls } = fakeReader(async () => [MEETING]);
    const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL });
    expect((await handler.handle(ctx('이번 주 일정')))?.reply.text).toContain('이번 주 · 10월 5일(월) ~ 10월 11일(일): 일정 1개');
    expect(calls.at(-1)).toEqual({ from: '2026-10-04T15:00:00.000Z', to: '2026-10-11T15:00:00.000Z', limit: 50 });
    expect((await handler.handle(ctx('다음 회의 언제야?')))?.reply.text).toContain('다음 일정: 10월 7일(수) 09:00–10:00 팀 회의');
    expect(calls.at(-1)?.from).toBe(NOW);
    expect((await handler.handle(ctx("What's my next meeting?")))?.reply.text).toContain('Next on your calendar: Wed, Oct 7');
    expect((await handler.handle(ctx("What's on my calendar today?")))?.reply.text).toContain('Today · Tue, Oct 6');
  });

  it('leaves reminder phrases, how-to questions and ordinary chat alone without reading the calendar', async () => {
    const { reader, calls } = fakeReader(async () => [MEETING]);
    const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL });
    for (const text of [
      '내일 9시에 회의 알려줘',
      '내일 9시에 일정 알려줘',
      '매일 오전 8시에 오늘 일정 알려줘',
      '30분 뒤에 일정 확인 알려줘',
      'Remind me tomorrow at 9 about my schedule',
      '알림 목록',
      '캘린더 어떻게 써?',
      '일정 관리 팁 알려줘',
      '내 메일 확인해줘',
      '안녕',
    ]) {
      expect(await handler.handle(ctx(text)), text).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('hands calendar writes to the runtime as a write draft with the fixed read-only refusal as fallback, and makes no read', async () => {
    const { reader, calls } = fakeReader(async () => [MEETING]);
    const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL });
    const ko = await handler.handle(ctx('내일 3시 회의 일정 추가해줘'));
    expect(ko).toMatchObject({ kind: 'write-draft' });
    if (ko?.kind !== 'write-draft') throw new Error('expected a write draft');
    expect(ko.fallbackText).toBe('지금은 캘린더를 읽기만 할 수 있어요. 일정 추가·변경·삭제는 아직 지원하지 않아서 아무것도 바꾸지 않았어요.');
    expect(ko.history?.assistant).toBe(renderCalendarHistoryNote('ko'));
    expect(ko.draft).toMatchObject({ kind: 'calendar-create', event: { title: '회의' } });
    const en = await handler.handle(ctx('cancel my 3pm meeting'));
    expect(en?.kind === 'write-draft' && en.fallbackText).toContain('nothing was changed');
    expect(en?.kind === 'write-draft' && en.draft.kind).toBe('usage');
    // The move / delete forms without a calendar noun are writes too (CWR-2), never schedule questions.
    for (const text of ['내일 3시 회의 4시로 옮겨줘', '내일 3시 회의 취소해줘']) {
      const draft = await handler.handle(ctx(text));
      expect(draft?.kind, text).toBe('write-draft');
    }
    expect(calls).toHaveLength(0);
  });

  it('lists the write forms in its help line only when calendar writes are bound', () => {
    const { reader } = fakeReader(async () => []);
    expect(createCalendarTurnHandler({ reader, timeZone: SEOUL }).helpLines).toEqual(CALENDAR_HELP_LINES);
    const writable = createCalendarTurnHandler({ reader, timeZone: SEOUL, writesEnabled: true });
    expect(writable.helpLines).toEqual(CALENDAR_WRITE_HELP_LINES);
    for (const line of writable.helpLines) expect(Array.from(line).length).toBeLessThanOrEqual(120);
    expect(writable.helpLines.join('\n')).not.toContain('읽기 전용');
  });

  it('answers a failed read truthfully (FAILED, never "no events") and logs the reason code only', async () => {
    for (const [error, expected] of [
      [new ConnectorQueryError('UNAUTHORIZED', 'google calendar: token request failed (unauthorized)'), 'calendar-auth'],
      [new ConnectorQueryError('FORBIDDEN', 'x'), 'calendar-auth'],
      [new ConnectorQueryError('RATE_LIMITED', 'x'), '요청 한도'],
      [new ConnectorQueryError('UNAVAILABLE', 'x'), '연결할 수 없어서'],
      [new Error('boom'), '연결할 수 없어서'],
    ] as const) {
      const { reader } = fakeReader(async () => {
        throw error;
      });
      const log = logger();
      const outcome = await createCalendarTurnHandler({ reader, timeZone: SEOUL, logger: log }).handle(ctx('오늘 일정'));
      expect(outcome?.status).toBe('FAILED');
      expect(outcome?.reply.text).toContain(expected);
      expect(outcome?.reply.text).not.toContain('일정이 없어요');
      expect(log.warn).toHaveBeenCalledWith('calendar.turn_handler.read_failed', expect.objectContaining({ span: 'day' }));
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('token request');
    }
  });

  it('times out a hung read', async () => {
    const { reader } = fakeReader(() => new Promise(() => undefined));
    const outcome = await createCalendarTurnHandler({ reader, timeZone: SEOUL, timeoutMs: 5 }).handle(ctx('오늘 일정'));
    expect(outcome?.status).toBe('FAILED');
    expect(outcome?.reply.text).toContain('제한 시간');
  });

  it('answers a date the calendar does not have without reading', async () => {
    const { reader, calls } = fakeReader(async () => []);
    const outcome = await createCalendarTurnHandler({ reader, timeZone: SEOUL }).handle(ctx('2월 30일 일정'));
    expect(outcome?.reply.text).toContain('달력에 없는 날짜');
    expect(calls).toHaveLength(0);
  });
});

describe('CalendarTurnHandler — "남은 일정" keeps only events that have not finished (Codex P2 on 5594c16)', () => {
  /** Tuesday 2026-10-06 15:00 in Asia/Seoul. */
  const AT_15 = '2026-10-06T06:00:00.000Z';
  const at15 = (text: string): TurnHandlerContext => ({ ...ctx(text), now: AT_15 });
  const event = (id: string, title: string, start: string, end: string): CalendarEvent => ({
    id, title, start, end, allDay: false, status: 'confirmed', calendarName: 'primary',
  });
  const MORNING = event('e-am', '아침 스탠드업', '2026-10-06T00:00:00.000Z', '2026-10-06T01:00:00.000Z'); // 09:00–10:00, over
  const ONGOING = event('e-now', '진행 중 리뷰', '2026-10-06T05:30:00.000Z', '2026-10-06T06:30:00.000Z'); // 14:30–15:30
  const LATER = event('e-pm', '저녁 회의', '2026-10-06T07:00:00.000Z', '2026-10-06T08:00:00.000Z'); // 16:00–17:00
  const ENDS_NOW = event('e-edge', '방금 끝난 통화', '2026-10-06T05:00:00.000Z', AT_15); // 14:00–15:00, ends exactly now

  it('at 15:00 KST "오늘 남은 일정" reads from now, drops the 09:00–10:00 event and says "남은 일정 N개"', async () => {
    // The reader returns the whole day anyway: the handler still drops what already ended.
    const { reader, calls } = fakeReader(async () => [MORNING, ENDS_NOW, ONGOING, LATER]);
    const outcome = await createCalendarTurnHandler({ reader, timeZone: SEOUL }).handle(at15('오늘 남은 일정'));
    expect(calls).toEqual([{ from: AT_15, to: '2026-10-06T15:00:00.000Z', limit: 50 }]);
    const text = (outcome as { reply: { text: string } }).reply.text;
    expect(text.split('\n')[0]).toBe('오늘 · 10월 6일(화): 남은 일정 2개');
    expect(text).toContain('진행 중 리뷰');
    expect(text).toContain('저녁 회의');
    expect(text).not.toContain('아침 스탠드업');
    expect(text).not.toContain('방금 끝난 통화');
  });

  it('nothing left says so; "오늘 일정" at the same time still lists the whole day', async () => {
    const empty = await createCalendarTurnHandler({ reader: fakeReader(async () => [MORNING]).reader, timeZone: SEOUL }).handle(
      at15('오늘 남은 일정 있어?'),
    );
    expect((empty as { reply: { text: string } }).reply.text.split('\n')[0]).toBe('오늘 · 10월 6일(화): 남은 일정이 없어요.');
    const { reader, calls } = fakeReader(async () => [MORNING, LATER]);
    const whole = await createCalendarTurnHandler({ reader, timeZone: SEOUL }).handle(at15('오늘 일정'));
    expect(calls[0]?.from).toBe('2026-10-05T15:00:00.000Z');
    expect((whole as { reply: { text: string } }).reply.text.split('\n')[0]).toBe('오늘 · 10월 6일(화): 일정 2개');
  });

  it('a future day reads its whole window; a day that is already over reads nothing', async () => {
    const { reader, calls } = fakeReader(async () => []);
    const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL });
    await handler.handle(at15('내일 남은 일정'));
    expect(calls).toEqual([{ from: '2026-10-06T15:00:00.000Z', to: '2026-10-07T15:00:00.000Z', limit: 50 }]);
    const past = await handler.handle(at15('어제 남은 일정'));
    expect(calls).toHaveLength(1);
    expect((past as { reply: { text: string } }).reply.text).toContain('남은 일정이 없어요');
  });
});
