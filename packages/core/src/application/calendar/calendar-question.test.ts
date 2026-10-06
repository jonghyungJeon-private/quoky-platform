import { describe, expect, it } from 'vitest';
import { detectPolicySensitiveChat, isPersonalScheduleQuestion } from '../intent-classifier';
import {
  CALENDAR_NEXT_EVENT_LOOKAHEAD_DAYS,
  extractSpan,
  isCalendarWriteRequest,
  parseCalendarQuestion,
  placeCalendarSpan,
  type CalendarSpan,
} from './calendar-question';

/** Tuesday 2026-10-06 10:00 in Asia/Seoul. */
const NOW = '2026-10-06T01:00:00.000Z';
const SEOUL = 'Asia/Seoul';

describe('calendar question grammar (ADR-0110 D3)', () => {
  it.each<[string, CalendarSpan, 'ko' | 'en']>([
    // The task's phrases.
    ['오늘 일정', { kind: 'day', offset: 0 }, 'ko'],
    ['내일 일정 뭐야?', { kind: 'day', offset: 1 }, 'ko'],
    ['이번 주 일정', { kind: 'week', which: 'this' }, 'ko'],
    ['다음 회의 언제야?', { kind: 'next' }, 'ko'],
    ["What's on my calendar today?", { kind: 'day', offset: 0 }, 'en'],
    ['Show my schedule for tomorrow', { kind: 'day', offset: 1 }, 'en'],
    ["today's schedule", { kind: 'day', offset: 0 }, 'en'],
    ['this week calendar', { kind: 'week', which: 'this' }, 'en'],
    ["What's my next meeting?", { kind: 'next' }, 'en'],
    // More schedule questions (the QUAL-7 subset and whole-message requests).
    ['오늘 일정 알려줘', { kind: 'day', offset: 0 }, 'ko'],
    ['내일 일정 보여줘', { kind: 'day', offset: 1 }, 'ko'],
    ['내일 9시에 뭐 있어?', { kind: 'day', offset: 1 }, 'ko'],
    ['오늘 뭐 있어?', { kind: 'day', offset: 0 }, 'ko'],
    ['나 내일 바빠?', { kind: 'day', offset: 1 }, 'ko'],
    ['다음 주 일정', { kind: 'week', which: 'next' }, 'ko'],
    ['이번 주말 일정', { kind: 'weekend', which: 'this' }, 'ko'],
    ['다음 주 금요일 일정', { kind: 'weekday', weekday: 5, week: 'next' }, 'ko'],
    ['금요일 일정 있어?', { kind: 'weekday', weekday: 5, week: 'nearest' }, 'ko'],
    ['10월 7일 일정', { kind: 'date', month: 10, day: 7 }, 'ko'],
    ['다음 약속 언제야?', { kind: 'next' }, 'ko'],
    ['내 일정', { kind: 'day', offset: 0 }, 'ko'],
    ['캘린더 보여줘', { kind: 'day', offset: 0 }, 'ko'],
    ['오늘 회의', { kind: 'day', offset: 0 }, 'ko'],
    ['Any meetings today?', { kind: 'day', offset: 0 }, 'en'],
    ['do I have meetings tomorrow?', { kind: 'day', offset: 1 }, 'en'],
    ["what's on tomorrow?", { kind: 'day', offset: 1 }, 'en'],
    ['Am I free tomorrow?', { kind: 'day', offset: 1 }, 'en'],
    ['what are my plans this weekend?', { kind: 'weekend', which: 'this' }, 'en'],
    ['When is my upcoming appointment?', { kind: 'next' }, 'en'],
  ])('claims %s', (text, span, language) => {
    expect(parseCalendarQuestion(text)).toEqual({ kind: 'events', span, language });
  });

  it.each([
    // How-to, advice and code questions.
    '일정 관리 팁 알려줘',
    '오늘 일정 정리하는 법',
    '캘린더 어떻게 써?',
    'how do I share my calendar?',
    'cron 스케줄 추가해줘',
    'my calendar app crashes',
    // Statements and other personal data.
    '오늘 일정 없어',
    '내일 너무 바빠서 못 갈 것 같아',
    '내 메일 확인해줘',
    'Any emails today?',
    'check my email',
    '부재중 전화 몇 개야?',
    'Do I have time to learn Rust?',
    // Not calendar at all.
    '회의',
    '회의록 정리 완료',
    '7/3 회의 등록해줘',
    '할 일 추가: 주간 보고서 쓰기',
    '',
    `오늘 일정 ${'가'.repeat(250)}`,
  ])('does not claim %j', (text) => {
    expect(parseCalendarQuestion(text)).toBeNull();
  });

  it('refuses calendar writes (create, move, delete) without claiming code schedules or plain meeting notes', () => {
    for (const text of [
      '내일 3시 회의 일정 추가해줘',
      '캘린더에 내일 점심 약속 넣어줘',
      '내일 회의 일정 옮겨줘',
      '금요일 일정 삭제해줘',
      'add a meeting to my calendar tomorrow',
      'cancel my 3pm meeting',
      'Can you reschedule my meeting with Kim?',
    ]) {
      expect(isCalendarWriteRequest(text), text).toBe(true);
      expect(parseCalendarQuestion(text)?.kind, text).toBe('write-refused');
    }
    for (const text of ['cron 스케줄 추가해줘', '스케줄러에 작업 등록해줘', '7/3 회의 등록해줘', '내일 일정 뭐야?']) {
      expect(isCalendarWriteRequest(text), text).toBe(false);
    }
  });
});

describe('QUAL-7 switch: isPersonalScheduleQuestion (ADR-0110, amends the ADR-0098 amendment)', () => {
  it('is the schedule subset of the personal-data route; mail, messages and money are not schedule questions', () => {
    for (const text of ['나 내일 바빠?', '내일 오후 3시 비어 있어?', "What's my next meeting?", 'Am I free tomorrow?', '다음 약속 언제야?']) {
      expect(detectPolicySensitiveChat(text), text).toBe('personal-data');
      expect(isPersonalScheduleQuestion(text), text).toBe(true);
    }
    for (const text of ['부재중 전화 몇 개야?', '내 메일 확인해줘', 'check my email', 'what is my bank balance', '예약 내역 보여줘']) {
      expect(detectPolicySensitiveChat(text), text).toBe('personal-data');
      expect(isPersonalScheduleQuestion(text), text).toBe(false);
    }
    for (const text of ['일정 관리 팁 알려줘', '내일 너무 바빠서 못 갈 것 같아', 'Do I have time to learn Rust?']) {
      expect(isPersonalScheduleQuestion(text), text).toBe(false);
    }
  });
});

describe('extractSpan', () => {
  it('reads week-qualified forms before "다음 (회의)" and defaults to today', () => {
    expect(extractSpan('다음 주 회의 있어?')).toEqual({ kind: 'week', which: 'next' });
    expect(extractSpan('다음 주말 일정')).toEqual({ kind: 'weekend', which: 'next' });
    expect(extractSpan('이번 주 수요일 일정')).toEqual({ kind: 'weekday', weekday: 3, week: 'this' });
    expect(extractSpan('모레 일정')).toEqual({ kind: 'day', offset: 2 });
    expect(extractSpan('어제 일정')).toEqual({ kind: 'day', offset: -1 });
    expect(extractSpan('10/12 일정')).toEqual({ kind: 'date', month: 10, day: 12 });
    expect(extractSpan('schedule for next Monday')).toEqual({ kind: 'weekday', weekday: 1, week: 'next' });
    expect(extractSpan('calendar for Oct 9')).toEqual({ kind: 'date', month: 10, day: 9 });
    expect(extractSpan('내 일정')).toEqual({ kind: 'day', offset: 0 });
  });
});

describe('placeCalendarSpan (QUOKY_TIMEZONE windows)', () => {
  it('places days, weekdays, dates, weeks and weekends on local midnights in Asia/Seoul', () => {
    expect(placeCalendarSpan({ kind: 'day', offset: 0 }, NOW, SEOUL)).toMatchObject({
      from: '2026-10-05T15:00:00.000Z',
      to: '2026-10-06T15:00:00.000Z',
      startDate: { year: 2026, month: 10, day: 6 },
      days: 1,
      dayOffset: 0,
    });
    expect(placeCalendarSpan({ kind: 'day', offset: 1 }, NOW, SEOUL)?.from).toBe('2026-10-06T15:00:00.000Z');
    // Tuesday: this week runs Monday 10/5 .. Sunday 10/11; the weekend is 10/10–10/11.
    expect(placeCalendarSpan({ kind: 'week', which: 'this' }, NOW, SEOUL)).toMatchObject({
      from: '2026-10-04T15:00:00.000Z',
      to: '2026-10-11T15:00:00.000Z',
      days: 7,
    });
    expect(placeCalendarSpan({ kind: 'week', which: 'next' }, NOW, SEOUL)?.startDate).toEqual({ year: 2026, month: 10, day: 12 });
    expect(placeCalendarSpan({ kind: 'weekend', which: 'this' }, NOW, SEOUL)).toMatchObject({
      startDate: { year: 2026, month: 10, day: 10 },
      days: 2,
    });
    // "화요일" on a Tuesday is today; "금요일" is this Friday; "다음 주 화요일" is 10/13; "이번 주 월요일" is 10/5.
    expect(placeCalendarSpan({ kind: 'weekday', weekday: 2, week: 'nearest' }, NOW, SEOUL)?.startDate.day).toBe(6);
    expect(placeCalendarSpan({ kind: 'weekday', weekday: 5, week: 'nearest' }, NOW, SEOUL)?.startDate.day).toBe(9);
    expect(placeCalendarSpan({ kind: 'weekday', weekday: 2, week: 'next' }, NOW, SEOUL)?.startDate.day).toBe(13);
    expect(placeCalendarSpan({ kind: 'weekday', weekday: 1, week: 'this' }, NOW, SEOUL)?.startDate.day).toBe(5);
    expect(placeCalendarSpan({ kind: 'weekday', weekday: 0, week: 'nearest' }, NOW, SEOUL)?.startDate.day).toBe(11);
  });

  it('uses the local date, not the UTC date, at the zone boundary', () => {
    // 2026-10-06 23:30 UTC is already Wednesday 10/7 08:30 in Seoul.
    const lateUtc = '2026-10-06T23:30:00.000Z';
    expect(placeCalendarSpan({ kind: 'day', offset: 0 }, lateUtc, SEOUL)?.startDate).toEqual({ year: 2026, month: 10, day: 7 });
    expect(placeCalendarSpan({ kind: 'day', offset: 0 }, lateUtc, 'UTC')?.startDate).toEqual({ year: 2026, month: 10, day: 6 });
  });

  it('keeps a DST day whole (America/New_York, 2026-11-01 is 25 hours long)', () => {
    const window = placeCalendarSpan({ kind: 'date', month: 11, day: 1 }, NOW, 'America/New_York');
    expect(window?.from).toBe('2026-11-01T04:00:00.000Z');
    expect(window?.to).toBe('2026-11-02T05:00:00.000Z');
  });

  it('picks the nearest occurrence of a month/day and refuses a date that does not exist', () => {
    expect(placeCalendarSpan({ kind: 'date', month: 1, day: 3 }, NOW, SEOUL)?.startDate.year).toBe(2027);
    expect(placeCalendarSpan({ kind: 'date', month: 9, day: 30 }, NOW, SEOUL)?.startDate.year).toBe(2026);
    expect(placeCalendarSpan({ kind: 'date', month: 2, day: 30 }, NOW, SEOUL)).toBeUndefined();
    expect(placeCalendarSpan({ kind: 'date', month: 24, day: 7 }, NOW, SEOUL)).toBeUndefined();
  });

  it('looks ahead from now (not midnight) for the next event', () => {
    const window = placeCalendarSpan({ kind: 'next' }, NOW, SEOUL);
    expect(window?.from).toBe(NOW);
    expect(window?.days).toBe(CALENDAR_NEXT_EVENT_LOOKAHEAD_DAYS);
    expect(window?.to).toBe('2026-10-19T15:00:00.000Z');
  });
});
