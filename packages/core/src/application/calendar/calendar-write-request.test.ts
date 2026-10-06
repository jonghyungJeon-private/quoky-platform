import { describe, expect, it } from 'vitest';
import { isCalendarWriteRequest } from './calendar-question';
import { parseCalendarWriteRequest } from './calendar-write-request';

/** Tuesday 2026-10-06 10:00 in Asia/Seoul. */
const OPTIONS = { now: '2026-10-06T01:00:00.000Z', timeZone: 'Asia/Seoul' };
const parse = (text: string) => parseCalendarWriteRequest(text, OPTIONS);
const timed = (start: string, end: string) => ({ allDay: false, start, end, timeZone: 'Asia/Seoul' });
const TOMORROW_WINDOW = { from: '2026-10-06T15:00:00.000Z', to: '2026-10-07T15:00:00.000Z' };

describe('calendar write grammar (ADR-0110 amendment D3, CWR-2)', () => {
  it.each([
    ['내일 오후 3시에 회의 잡아줘 제목 주간 회의', { title: '주간 회의', time: timed('2026-10-07T06:00:00.000Z', '2026-10-07T07:00:00.000Z') }],
    ['내일 3시에 미팅 잡아줘', { title: '미팅', time: timed('2026-10-07T06:00:00.000Z', '2026-10-07T07:00:00.000Z') }],
    ['내일 오전 9시 반에 면담 잡아줘', { title: '면담', time: timed('2026-10-07T00:30:00.000Z', '2026-10-07T01:30:00.000Z') }],
    ['금요일 오후 2시부터 4시까지 회의 잡아줘 제목 리뷰 장소 3층', {
      title: '리뷰', location: '3층', time: timed('2026-10-09T05:00:00.000Z', '2026-10-09T07:00:00.000Z'),
    }],
    ['내일 15:00에 30분 동안 통화 일정 추가해줘', { title: '통화', time: timed('2026-10-07T06:00:00.000Z', '2026-10-07T06:30:00.000Z') }],
    ['내일 3시에 2시간 회의 잡아줘 제목 "설계 리뷰"로 잡아줘', { title: '설계 리뷰', time: timed('2026-10-07T06:00:00.000Z', '2026-10-07T08:00:00.000Z') }],
    ['10월 9일 종일 일정 잡아줘 제목 휴가', { title: '휴가', time: { allDay: true, startDate: '2026-10-09', endDate: '2026-10-10' } }],
  ])('create: "%s"', (text, event) => {
    expect(isCalendarWriteRequest(text), text).toBe(true);
    expect(parse(text)).toEqual({ kind: 'calendar-create', event });
  });

  it('move, rename and delete produce a reference, never an event id', () => {
    expect(parse('내일 3시 회의 4시로 옮겨줘')).toEqual({
      kind: 'calendar-update',
      ref: { date: { year: 2026, month: 10, day: 7 }, window: TOMORROW_WINDOW, startTime: { hour: 15, minute: 0 }, titleWords: [] },
      changes: { moveTo: { time: { hour: 16, minute: 0 } } },
    });
    expect(parse('내일 3시 회의 모레 오전 10시로 미뤄줘')).toMatchObject({
      kind: 'calendar-update',
      changes: { moveTo: { date: { year: 2026, month: 10, day: 8 }, time: { hour: 10, minute: 0 } } },
    });
    expect(parse('내일 3시 "주간 회의" 제목을 팀 회의로 바꿔줘')).toMatchObject({
      kind: 'calendar-update',
      ref: { titleWords: ['주간', '회의'] },
      changes: { title: '팀 회의' },
    });
    expect(parse('내일 3시 회의 취소해줘')).toEqual({
      kind: 'calendar-delete',
      ref: { date: { year: 2026, month: 10, day: 7 }, window: TOMORROW_WINDOW, startTime: { hour: 15, minute: 0 }, titleWords: [] },
    });
    expect(parse('내일 회의 삭제해줘')).toMatchObject({ kind: 'calendar-delete', ref: { titleWords: [] } });
  });

  it.each([
    ['이번 주 회의 취소해줘', 'calendar-span'],
    ['다음 회의 취소해줘', 'calendar-span'],
    ['내일 회의 옮겨줘', 'calendar-change'],
    ['내일 일정 잡아줘', 'calendar-create'],
    ['cancel my 3pm meeting', 'calendar-change'],
  ])('"%s" is a usage hint (%s)', (text, topic) => {
    expect(parse(text)).toEqual({ kind: 'usage', topic });
  });

  it('move / delete forms without a calendar noun are writes; content requests about a meeting are not', () => {
    for (const text of ['내일 3시 회의 4시로 옮겨줘', '내일 3시 회의 취소해줘', '금요일 오후 2시 미팅 삭제해줘', '내일 회의를 3시로 미뤄줘']) {
      expect(isCalendarWriteRequest(text), text).toBe(true);
    }
    for (const text of ['오늘 회의 내용을 표로 바꿔줘', '내일 회의록 바꿔줘', '내일 3시 회의 취소했어', '내일 회의 취소하지 마']) {
      expect(isCalendarWriteRequest(text), text).toBe(false);
    }
  });

  it('never throws', () => {
    for (const text of ['', '   ', '내일', '\u0000', '가'.repeat(5000)]) expect(() => parse(text)).not.toThrow();
  });
});
