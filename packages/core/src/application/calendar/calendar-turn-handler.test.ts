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
import { resolveNlRange } from '../nl-routing/symbolic-time';

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
      // ADR-0120 follow-up: the structural catalog equivalent, content-free.
      nlSelection: { entryId: 'calendar.events', args: { range: 'tomorrow' } },
    });
    expect(JSON.stringify(outcome?.history)).not.toContain('팀 회의');
    // Never a `summarize` outcome: no provider (LOCAL or REMOTE) ever sees calendar text (ADR-0110 D4).
    expect((outcome as { kind?: string }).kind).toBeUndefined();
    // Logs carry no message or event text.
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toMatch(/팀 회의|내일 일정/);
  });

  it('names the catalog equivalent of every span it answers (ADR-0120 follow-up)', async () => {
    const { reader } = fakeReader(async () => [MEETING]);
    const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL });
    const selection = async (text: string) => (await handler.handle(ctx(text)) as { nlSelection?: unknown } | null)?.nlSelection;
    expect(await selection('오늘 일정')).toEqual({ entryId: 'calendar.events', args: {} });
    expect(await selection('이번 주 일정')).toEqual({ entryId: 'calendar.events', args: { range: 'this-week' } });
    expect(await selection('다음 주말 일정')).toEqual({ entryId: 'calendar.events', args: { range: 'next-weekend' } });
    expect(await selection('다음 회의 언제야?')).toEqual({ entryId: 'calendar.events', args: { range: 'upcoming' } });
    expect(await selection('오늘 남은 일정')).toEqual({ entryId: 'calendar.events', args: { remaining: true } });
    expect(await selection('금요일 일정')).toEqual({ entryId: 'calendar.events', args: { range: '2026-10-09' } });
  });

  it('declines a schedule question with an inexpressible qualifier only when the runtime says selection would run (ADR-0120 amendment A2)', async () => {
    const { reader, calls } = fakeReader(async () => [MEETING]);
    const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL });
    const yielding = (text: string): TurnHandlerContext => ({ ...ctx(text), grammarYield: true });
    // The grammar answers this on main (the whole week, ignoring "정기회의"); flag off it still does, byte for byte.
    expect(await handler.handle(yielding('이번 주 정기회의 일정 있어?'))).toBeNull();
    expect(await handler.handle(ctx('이번 주 정기회의 일정 있어?'))).toMatchObject({ status: 'RESPONDED', nlSelection: { entryId: 'calendar.events', args: { range: 'this-week' } } });
    // The grammar never claimed these: the same with or without the yield.
    for (const text of ['내일 스크럼 몇 시야', '오늘 위클리카 관련 일정', '이번 주 회의 중에 오후 거만', '이번 달 일정 보여줘', '스크럼 일정']) {
      expect(await handler.handle(yielding(text)), text).toBeNull();
      expect(await handler.handle(ctx(text)), `${text} (off)`).toBeNull();
    }
    expect(calls.length).toBe(1);
    // No leftover qualifier: the grammar answers exactly as before even when it may yield.
    for (const text of ['이번 주 일정 있어?', '내일 오후 일정 알려줘', '내일 9시에 뭐 있어?', '나 내일 바빠?']) {
      expect(await handler.handle(yielding(text)), text).toEqual(await handler.handle(ctx(text)));
    }
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

describe('CalendarTurnHandler.handleSelected — title keyword (ADR-0120 follow-up)', () => {
  const SCRUM: CalendarEvent = { ...MEETING, id: 'e-2', title: 'Daily SCRUM', start: '2026-10-06T00:00:00.000Z', end: '2026-10-06T00:30:00.000Z' };
  const REVIEW: CalendarEvent = { ...MEETING, id: 'e-3', title: '디자인 리뷰', start: '2026-10-06T05:00:00.000Z', end: '2026-10-06T06:00:00.000Z' };
  const selected = (args: Record<string, string | boolean>, range: 'today' | 'this-week' = 'today') => ({
    entryId: 'calendar.events' as const,
    args,
    range: resolveNlRange(range, NOW, SEOUL),
    language: 'ko' as const,
  });

  it('filters the fetched events locally on the title, case-insensitively, and reads the whole range from the reader', async () => {
    const { reader, calls } = fakeReader(async () => [SCRUM, REVIEW, MEETING]);
    const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL });
    const outcome = await handler.handleSelected?.(selected({ keyword: 'scrum' }), ctx('그 중에 scrum만'));
    const text = (outcome as { reply: { text: string } }).reply.text;
    expect(calls).toHaveLength(1);
    expect(text).toContain('Daily SCRUM');
    expect(text).not.toContain('디자인 리뷰');
    expect(text).not.toContain('팀 회의');
    expect(text).toContain('일정 1개');
  });

  it('says honestly that nothing matched, naming the keyword', async () => {
    const { reader } = fakeReader(async () => [REVIEW, MEETING]);
    const outcome = await createCalendarTurnHandler({ reader, timeZone: SEOUL }).handleSelected?.(selected({ keyword: '스크럼' }), ctx('오늘 스크럼 있어?'));
    const text = (outcome as { reply: { text: string } }).reply.text;
    expect(text).toContain('"스크럼"');
    expect(text).toContain('일정이 없어요');
    expect(text).not.toContain('리뷰');
  });

  it('keeps the unfiltered answer when no keyword is given', async () => {
    const { reader } = fakeReader(async () => [SCRUM, REVIEW]);
    const outcome = await createCalendarTurnHandler({ reader, timeZone: SEOUL }).handleSelected?.(selected({}), ctx('오늘 일정'));
    const text = (outcome as { reply: { text: string } }).reply.text;
    expect(text).toContain('Daily SCRUM');
    expect(text).toContain('디자인 리뷰');
  });

  it('a keyword on the next event answers the next matching event or says none upcoming', async () => {
    const future: CalendarEvent = { ...SCRUM, start: '2026-10-07T00:00:00.000Z', end: '2026-10-07T00:30:00.000Z' };
    const { reader } = fakeReader(async () => [REVIEW, future]);
    const handler = createCalendarTurnHandler({ reader, timeZone: SEOUL });
    const hit = await handler.handleSelected?.({ ...selected({ keyword: 'scrum' }), range: resolveNlRange('upcoming', NOW, SEOUL) }, ctx('다음 스크럼 언제야?'));
    expect((hit as { reply: { text: string } }).reply.text).toContain('Daily SCRUM');
    const miss = await handler.handleSelected?.({ ...selected({ keyword: '면접' }), range: resolveNlRange('upcoming', NOW, SEOUL) }, ctx('다음 면접 언제야?'));
    expect((miss as { reply: { text: string } }).reply.text).toContain('"면접"');
  });

  it('a keyword over a full page is partial: an empty result says it could not check everything, a hit is flagged too', async () => {
    const page = (title: string): CalendarEvent[] => Array.from({ length: 50 }, (_, i) => ({ ...REVIEW, id: `p-${i}`, title: `${title} ${i}` }));
    const miss = await createCalendarTurnHandler({ reader: fakeReader(async () => page('리뷰')).reader, timeZone: SEOUL }).handleSelected?.(selected({ keyword: '스크럼' }), ctx('오늘 스크럼 있어?'));
    expect((miss as { reply: { text: string } }).reply.text).toContain('"스크럼" 포함 일정이 없어요 (전체를 확인하진 못했어요)');
    const hit = await createCalendarTurnHandler({ reader: fakeReader(async () => [...page('리뷰'), SCRUM]).reader, timeZone: SEOUL }).handleSelected?.(selected({ keyword: 'scrum' }), ctx('오늘 scrum'));
    expect((hit as { reply: { text: string } }).reply.text).toContain('전체를 확인하진 못했어요');
    // a short page is complete: no partial note
    const complete = await createCalendarTurnHandler({ reader: fakeReader(async () => [REVIEW]).reader, timeZone: SEOUL }).handleSelected?.(selected({ keyword: '스크럼' }), ctx('오늘 스크럼 있어?'));
    expect((complete as { reply: { text: string } }).reply.text).not.toContain('전체를 확인하진');
  });
});

describe('CalendarTurnHandler.handleSelected — part of day, timed-only and availability (live UAT R2/R5)', () => {
  // NOW is Tue 2026-10-06 10:00 Asia/Seoul; tomorrow is Wed 2026-10-07.
  const timed = (id: string, title: string, startKst: string, endKst: string, day = '2026-10-07'): CalendarEvent => ({
    ...MEETING,
    id,
    title,
    start: `${day}T${startKst}:00+09:00`,
    end: `${day}T${endKst}:00+09:00`,
  });
  const LEAVE: CalendarEvent = { ...MEETING, id: 'a-1', title: '[연차] 홍길동', start: '2026-10-07', end: '2026-10-08', allDay: true };
  const SCRUM = timed('t-1', '아침 스크럼', '09:30', '10:00');
  const STRADDLE = timed('t-2', '점심 걸친 회의', '11:30', '12:30');
  const WEEKLY = timed('t-3', '주간 회의', '13:00', '14:00');
  const LATE = timed('t-4', '저녁 모임', '19:00', '20:00');
  const day = [LEAVE, SCRUM, STRADDLE, WEEKLY, LATE];
  const selected = (args: Record<string, string | boolean>, range = 'tomorrow') => ({
    entryId: 'calendar.events' as const,
    args,
    range: resolveNlRange(range, NOW, SEOUL),
    language: 'ko' as const,
  });
  const textOf = (outcome: unknown) => (outcome as { reply: { text: string } }).reply.text;
  const run = async (events: CalendarEvent[], args: Record<string, string | boolean>, range?: string) => {
    const { reader } = fakeReader(async () => events);
    return textOf(await createCalendarTurnHandler({ reader, timeZone: SEOUL }).handleSelected?.(selected(args, range), ctx('x')));
  };

  it('afternoon keeps the timed events that overlap 12:00-18:00, drops the morning one and the all-day entry, and says so', async () => {
    const text = await run(day, { partOfDay: 'afternoon' });
    expect(text).toContain('내일 오후 · 10월 7일(수): 일정 2개');
    expect(text).toContain('주간 회의');
    expect(text).toContain('점심 걸친 회의');
    expect(text).not.toContain('아침 스크럼');
    expect(text).not.toContain('저녁 모임');
    expect(text).not.toContain('[연차]');
    expect(text).toContain('종일 일정 1개');
  });

  it('morning and evening use their own hours', async () => {
    const morning = await run(day, { partOfDay: 'morning' });
    expect(morning).toContain('아침 스크럼');
    expect(morning).toContain('점심 걸친 회의');
    expect(morning).not.toContain('주간 회의');
    const evening = await run(day, { partOfDay: 'evening' });
    expect(evening).toContain('저녁 모임');
    expect(evening).not.toContain('주간 회의');
    expect(evening).toContain('내일 저녁');
  });

  it('a free/busy question over an empty afternoon answers that the owner is free; without it the plain empty answer', async () => {
    const free = await run([SCRUM], { partOfDay: 'afternoon', availability: true });
    expect(free).toContain('내일 오후 · 10월 7일(수): 일정이 없어요 — 비어 있어요.');
    expect(free).not.toContain('아침 스크럼');
    const plain = await run([SCRUM], { partOfDay: 'afternoon' });
    expect(plain).toContain('내일 오후 · 10월 7일(수): 캘린더에 일정이 없어요.');
    expect(plain).not.toContain('비어 있어요');
  });

  it('a free/busy question over a busy afternoon lists the events instead of saying free', async () => {
    const busy = await run(day, { partOfDay: 'afternoon', availability: true });
    expect(busy).toContain('주간 회의');
    expect(busy).not.toContain('비어 있어요');
  });

  it('the part of day applies to every day of a multi-day period', async () => {
    const thursday = timed('t-5', '목요일 오후 회의', '15:00', '16:00', '2026-10-08');
    const thursdayMorning = timed('t-6', '목요일 오전 회의', '10:00', '11:00', '2026-10-08');
    const text = await run([WEEKLY, thursday, thursdayMorning, SCRUM], { partOfDay: 'afternoon' }, 'this-week');
    expect(text).toContain('이번 주 오후');
    expect(text).toContain('주간 회의');
    expect(text).toContain('목요일 오후 회의');
    expect(text).not.toContain('목요일 오전 회의');
    expect(text).not.toContain('아침 스크럼');
  });

  it('timed-only drops the all-day entries (leave, holidays) and counts them; an all-day-only day says no meetings', async () => {
    const some = await run(day, { timedOnly: true });
    expect(some).toContain('일정 4개');
    expect(some).not.toContain('[연차]');
    expect(some).toContain('종일 일정 1개');
    const none = await run([LEAVE], { timedOnly: true });
    expect(none).toContain('시간이 정해진 일정은 없어요 (종일 일정 1개)');
  });

  it('part of day and timed-only combine, and the next-event window ignores both', async () => {
    const both = await run(day, { partOfDay: 'afternoon', timedOnly: true });
    expect(both).toContain('내일 오후');
    expect(both).toContain('주간 회의');
    const { reader } = fakeReader(async () => [WEEKLY]);
    const next = await createCalendarTurnHandler({ reader, timeZone: SEOUL }).handleSelected?.(
      { ...selected({ partOfDay: 'morning' }, 'upcoming'), range: resolveNlRange('upcoming', NOW, SEOUL) },
      ctx('다음 일정'),
    );
    expect(textOf(next)).toContain('주간 회의');
  });

  it('without a narrowing the answer is the unchanged whole-day list (all-day entries included)', async () => {
    const all = await run(day, {});
    expect(all).toContain('[연차]');
    expect(all).toContain('아침 스크럼');
    expect(all).toContain('일정 5개');
    expect(all).not.toContain('종일 일정 1개');
  });
});

describe('CalendarTurnHandler.handleSelected — a full page narrowed after the read is partial (review P1)', () => {
  const day = '2026-10-07';
  const mk = (i: number, startKst: string, endKst: string): CalendarEvent => ({
    ...MEETING,
    id: `p-${i}`,
    title: `아침 일정 ${i}`,
    start: `${day}T${startKst}:00+09:00`,
    end: `${day}T${endKst}:00+09:00`,
  });
  const page = Array.from({ length: 50 }, (_, i) => mk(i, '09:00', '09:30'));
  const run = async (events: CalendarEvent[], args: Record<string, string | boolean>) => {
    const { reader } = fakeReader(async () => events);
    const out = await createCalendarTurnHandler({ reader, timeZone: SEOUL }).handleSelected?.(
      { entryId: 'calendar.events', args, range: resolveNlRange('tomorrow', NOW, SEOUL), language: 'ko' },
      ctx('x'),
    );
    return (out as { reply: { text: string } }).reply.text;
  };

  it('50 morning events at the read cap, then an afternoon availability ask: never "free"', async () => {
    const text = await run(page, { partOfDay: 'afternoon', availability: true });
    expect(text).not.toContain('비어 있어요');
    expect(text).toContain('비어 있다고는 말씀드릴 수 없어요');
    expect(text).toContain('전체를 확인하진 못했어요');
    expect(text).toContain('처음 50개까지만 읽었어요');
  });

  it('a timed-only ask over a full page of all-day entries never says there are no meetings outright', async () => {
    const allDay = page.map((event, i) => ({ ...event, id: `d-${i}`, allDay: true, start: day, end: '2026-10-08' }));
    const text = await run(allDay, { timedOnly: true });
    expect(text).toContain('전체를 확인하진 못했어요');
    expect(text).not.toContain('시간이 정해진 일정은 없어요');
  });

  it('a short page keeps the plain free answer; an all-day-only window says no timed events instead of a bare free', async () => {
    expect(await run([mk(1, '09:00', '09:30')], { partOfDay: 'afternoon', availability: true })).toContain('비어 있어요.');
    const leave: CalendarEvent = { ...MEETING, id: 'a', title: '휴가', allDay: true, start: day, end: '2026-10-08' };
    const whole = await run([leave], { availability: true });
    expect(whole).toContain('휴가');
    expect(whole).not.toContain('비어 있어요');
    const text = await run([leave], { partOfDay: 'afternoon', availability: true });
    expect(text).toContain('시간이 정해진 일정은 없어요 (종일 일정 1개)');
    expect(text).not.toContain('비어 있어요');
  });
});

describe('CalendarTurnHandler.handleSelected — part of day across a DST change (America/New_York, 2026-11-01)', () => {
  const NY = 'America/New_York';
  const NOW_NY = '2026-10-29T16:00:00.000Z';
  const at = (id: string, title: string, startZ: string, endZ: string): CalendarEvent => ({ ...MEETING, id, title, start: startZ, end: endZ });
  const run = async (range: string, partOfDay: string, events: CalendarEvent[]) => {
    const { reader } = fakeReader(async () => events);
    const out = await createCalendarTurnHandler({ reader, timeZone: NY }).handleSelected?.(
      { entryId: 'calendar.events', args: { partOfDay }, range: resolveNlRange(range, NOW_NY, NY), language: 'ko' },
      { ...ctx('x'), now: NOW_NY },
    );
    return (out as { reply: { text: string } }).reply.text;
  };
  // Sunday 2026-11-01 has 25 hours; local noon is 17:00Z (EST) and local 18:00 is 23:00Z.
  const morning = at('n-1', '해 바뀐 아침', '2026-11-01T16:30:00.000Z', '2026-11-01T16:50:00.000Z'); // 11:30 EST
  const afternoon = at('n-2', '해 바뀐 오후', '2026-11-01T17:30:00.000Z', '2026-11-01T18:30:00.000Z'); // 12:30 EST
  const lateEvening = at('n-3', '해 바뀐 밤', '2026-11-02T04:30:00.000Z', '2026-11-02T04:50:00.000Z'); // 23:30 EST

  it('uses the local hours of the 25-hour day, not a fixed UTC offset', async () => {
    const pm = await run('this-sun', 'afternoon', [morning, afternoon, lateEvening]);
    expect(pm).toContain('해 바뀐 오후');
    expect(pm).not.toContain('해 바뀐 아침');
    expect(pm).not.toContain('해 바뀐 밤');
    const night = await run('this-sun', 'evening', [morning, afternoon, lateEvening]);
    expect(night).toContain('해 바뀐 밤');
    expect(night).not.toContain('해 바뀐 오후');
    const am = await run('this-sun', 'morning', [morning, afternoon, lateEvening]);
    expect(am).toContain('해 바뀐 아침');
    expect(am).not.toContain('해 바뀐 오후');
  });

  it('a multi-day period uses EDT before the change and EST after it', async () => {
    const fri = at('f-1', '금요일 오후', '2026-10-30T16:30:00.000Z', '2026-10-30T17:30:00.000Z'); // 12:30 EDT
    const friMorning = at('f-2', '금요일 오전', '2026-10-30T15:30:00.000Z', '2026-10-30T15:50:00.000Z'); // 11:30 EDT
    const text = await run('this-week', 'afternoon', [fri, friMorning, afternoon, morning]);
    expect(text).toContain('금요일 오후');
    expect(text).toContain('해 바뀐 오후');
    expect(text).not.toContain('금요일 오전');
    expect(text).not.toContain('해 바뀐 아침');
  });
});
