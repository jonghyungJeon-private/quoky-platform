import { describe, expect, it } from 'vitest';
import type { ReminderSchedule } from '../../domain';
import {
  ANCHORED_TODO_PREFIX_HEADS,
  REMINDER_BRIEF_BODIES,
  parseReminderMessage,
  startsWithAnchoredTodoPrefix,
  type ReminderClarifyReason,
  type ReminderCommand,
} from './reminder-grammar';

/** Fixed now: Friday 2026-10-02 14:00 KST. */
const NOW = '2026-10-02T05:00:00.000Z';

/** A KST wall-clock time as a UTC ISO string (KST is UTC+9, no DST). */
function kst(local: string): string {
  return new Date(`${local}+09:00`).toISOString();
}

/** `now` given as KST wall clock. */
function at(local: string): string {
  return kst(local);
}

function parse(text: string, now = NOW, timeZone?: string): ReminderCommand {
  return parseReminderMessage(text, timeZone === undefined ? { now } : { now, timeZone });
}

function once(text: string, now = NOW): { body: string; at: string; kind: string } {
  const r = parse(text, now);
  if (r.kind !== 'CREATE' || r.schedule.type !== 'ONCE') throw new Error(`expected ONCE CREATE for ${text}: ${JSON.stringify(r)}`);
  return { body: r.body, at: r.firstFireAt, kind: r.bodyKind };
}

describe('reminder grammar — one-time Korean reminders (now = Fri 2026-10-02 14:00 KST)', () => {
  it.each([
    // [message, body, local fire time]
    ['내일 9시에 회의 준비 알려줘', '회의 준비', '2026-10-03T09:00'],
    ['내일 3시에 회의 알려줘', '회의', '2026-10-03T15:00'],
    ['30분 뒤에 스트레칭 알려줘', '스트레칭', '2026-10-02T14:30'],
    ['30분 후에 스트레칭 알려줘', '스트레칭', '2026-10-02T14:30'],
    ['1시간 30분 후에 스트레칭 알려줘', '스트레칭', '2026-10-02T15:30'],
    ['한 시간 반 뒤에 물 마시기 알려줘', '물 마시기', '2026-10-02T15:30'],
    ['2시간 뒤에 빨래 알려줘', '빨래', '2026-10-02T16:00'],
    ['3일 뒤에 택배 확인 알려줘', '택배 확인', '2026-10-05T14:00'],
    ['1분 뒤에 테스트 알려줘', '테스트', '2026-10-02T14:01'],
    ['다음 주 월요일 오후 3시에 보고서 제출 알려줘', '보고서 제출', '2026-10-05T15:00'],
    ['다음주 월요일 3시에 보고서 알려줘', '보고서', '2026-10-05T15:00'],
    ['다다음 주 수요일 10시에 발표 알려줘', '발표', '2026-10-14T10:00'],
    ['이번 주 일요일 오전 11시에 장보기 알려줘', '장보기', '2026-10-04T11:00'],
    ['이번 주 금요일 3시에 회의 알려줘', '회의', '2026-10-02T15:00'],
    ['월요일 9시에 출근 준비 알려줘', '출근 준비', '2026-10-05T09:00'],
    ['금요일 3시에 회의 알려줘', '회의', '2026-10-02T15:00'],
    ['금요일 1시에 회의 알려줘', '회의', '2026-10-09T13:00'], // today's 13:00 passed → next Friday
    ['모레 오전 10시에 병원 알려줘', '병원', '2026-10-04T10:00'],
    ['내일모레 7시에 운동 알려줘', '운동', '2026-10-04T07:00'],
    ['글피 8시에 출장 알려줘', '출장', '2026-10-05T08:00'],
    ['내일 오후 3시 30분에 치과 예약 알려줘', '치과 예약', '2026-10-03T15:30'],
    ['내일 9시 반에 회의 알려줘', '회의', '2026-10-03T09:30'],
    ['내일 오전 9시 5분에 회의 알려줘', '회의', '2026-10-03T09:05'],
    ['내일 21시에 약 먹기 알려줘', '약 먹기', '2026-10-03T21:00'],
    ['오늘 밤 9시에 일기 쓰기 알려줘', '일기 쓰기', '2026-10-02T21:00'],
    ['오늘 저녁 7시에 운동 알려줘', '운동', '2026-10-02T19:00'],
    ['오늘 오후 5시에 퇴근 알려줘', '퇴근', '2026-10-02T17:00'],
    ['10월 5일 9시에 회의 알려줘', '회의', '2026-10-05T09:00'],
    ['10월 2일 오후 6시에 저녁 약속 알려줘', '저녁 약속', '2026-10-02T18:00'],
    ['2026년 11월 3일 오후 2시에 세미나 알려줘', '세미나', '2026-11-03T14:00'],
    ['2026-10-05 09:00에 회의 알려줘', '회의', '2026-10-05T09:00'],
    ['내일 9시에 회의를 알려줘', '회의', '2026-10-03T09:00'],
    ['내일 9시에 점검을 알려줘', '점검', '2026-10-03T09:00'],
    ['내일 9시에 가을 산책 알려줘', '가을 산책', '2026-10-03T09:00'], // `을` of 가을 is not a particle
    ['내일 9시에 회의 준비라고 알려줘', '회의 준비', '2026-10-03T09:00'],
    ['회의 준비 내일 9시에 알려줘', '회의 준비', '2026-10-03T09:00'],
    ['내일 9시에 회의 준비 알려주세요', '회의 준비', '2026-10-03T09:00'],
    ['내일 9시에 회의 준비 리마인드 해줘', '회의 준비', '2026-10-03T09:00'],
    ['내일 9시에 회의 알림 줘', '회의', '2026-10-03T09:00'],
    ['내일 9시에 회의 알림 설정해줘', '회의', '2026-10-03T09:00'],
    ['내일9시에 회의 알려줘', '회의', '2026-10-03T09:00'],
    ['9시에 알려줘 약 먹기', '약 먹기', '2026-10-02T21:00'],
    ['  내일   9시에   회의   준비   알려줘  ', '회의 준비', '2026-10-03T09:00'],
  ])('%j → %j at %s', (message, body, local) => {
    expect(once(message)).toEqual({ body, at: kst(local), kind: 'TEXT' });
  });

  it('returns the full CREATE shape with the zone', () => {
    expect(parse('내일 9시에 회의 준비 알려줘')).toEqual({
      kind: 'CREATE',
      body: '회의 준비',
      bodyKind: 'TEXT',
      schedule: { type: 'ONCE', at: '2026-10-03T00:00:00.000Z' },
      firstFireAt: '2026-10-03T00:00:00.000Z',
      timeZone: 'Asia/Seoul',
    });
  });
});

describe('reminder grammar — meridiem policy (ADR-0101 D2)', () => {
  it.each([
    [1, 13],
    [2, 14],
    [3, 15],
    [4, 16],
    [5, 17],
    [6, 18],
    [7, 7],
    [8, 8],
    [9, 9],
    [10, 10],
    [11, 11],
    [12, 12],
  ])('with a date, %i시 means %i:00', (hour, expected) => {
    expect(once(`내일 ${hour}시에 회의 알려줘`).at).toBe(kst(`2026-10-03T${String(expected).padStart(2, '0')}:00`));
  });

  it.each([
    ['내일 오전 3시에 회의 알려줘', '2026-10-03T03:00'],
    ['내일 새벽 5시에 회의 알려줘', '2026-10-03T05:00'],
    ['내일 아침 6시에 회의 알려줘', '2026-10-03T06:00'],
    ['내일 오후 9시에 회의 알려줘', '2026-10-03T21:00'],
    ['내일 오후 11시에 회의 알려줘', '2026-10-03T23:00'],
    ['내일 저녁 6시에 회의 알려줘', '2026-10-03T18:00'],
    ['내일 밤 10시에 회의 알려줘', '2026-10-03T22:00'],
    ['내일 점심 12시에 회의 알려줘', '2026-10-03T12:00'],
    ['내일 낮 2시에 회의 알려줘', '2026-10-03T14:00'],
    ['내일 오후 12시에 회의 알려줘', '2026-10-03T12:00'],
    ['내일 오전 12시에 회의 알려줘', '2026-10-03T00:00'], // 오전 12시 = 00:00 of that day
    ['내일 0시에 회의 알려줘', '2026-10-03T00:00'],
    ['내일 13시에 회의 알려줘', '2026-10-03T13:00'],
    ['내일 09:30에 회의 알려줘', '2026-10-03T09:30'],
  ])('explicit marker or 24-hour time wins: %j', (message, local) => {
    expect(once(message).at).toBe(kst(local));
  });

  it.each([
    // bare time (no date, no marker) → nearest future of the two 12-hour readings
    ['3시에 회의 알려줘', NOW, '2026-10-02T15:00'],
    ['9시에 약 먹기 알려줘', NOW, '2026-10-02T21:00'],
    ['9시에 약 먹기 알려줘', at('2026-10-02T20:00'), '2026-10-02T21:00'],
    ['9시에 약 먹기 알려줘', at('2026-10-02T22:00'), '2026-10-03T09:00'],
    ['9시에 약 먹기 알려줘', at('2026-10-02T08:00'), '2026-10-02T09:00'],
    ['1시에 회의 알려줘', NOW, '2026-10-03T01:00'], // 01:00 and 13:00 both passed
    ['2시에 회의 알려줘', NOW, '2026-10-03T02:00'], // 14:00 is now, not future
    ['12시에 회의 알려줘', NOW, '2026-10-03T00:00'], // 00:00 next, 12:00 passed
    ['12시에 회의 알려줘', at('2026-10-02T09:00'), '2026-10-02T12:00'],
    // bare explicit/24-hour time → its next occurrence
    ['오전 9시에 회의 알려줘', NOW, '2026-10-03T09:00'],
    ['오후 5시에 회의 알려줘', NOW, '2026-10-02T17:00'],
    ['21:30에 약 알려줘', NOW, '2026-10-02T21:30'],
    ['09:30에 약 알려줘', NOW, '2026-10-03T09:30'],
    ['14시에 회의 알려줘', NOW, '2026-10-03T14:00'],
  ])('%j at %s → %s', (message, now, local) => {
    expect(once(message, now).at).toBe(kst(local));
  });

  it.each([
    ['밤 2시에 확인 알려줘', 'AMBIGUOUS_TIME'],
    ['내일 저녁 12시에 확인 알려줘', 'AMBIGUOUS_TIME'],
    ['내일 오전 13시에 확인 알려줘', 'INVALID_TIME'],
    ['내일 9시 75분에 확인 알려줘', 'INVALID_TIME'],
    ['내일 25시에 확인 알려줘', 'INVALID_TIME'],
  ] as const)('%j → CLARIFY %s', (message, reason) => {
    expect(parse(message)).toEqual({ kind: 'CLARIFY', reason });
  });
});

describe('reminder grammar — 자정, 정오, 오전 12시', () => {
  it.each([
    ['자정에 백업 확인 알려줘', NOW, '2026-10-03T00:00'],
    ['오늘 자정에 백업 알려줘', NOW, '2026-10-03T00:00'], // end of today
    ['내일 자정에 백업 알려줘', NOW, '2026-10-04T00:00'], // end of tomorrow
    ['오늘 밤 12시에 일기 알려줘', NOW, '2026-10-03T00:00'],
    ['내일 24시에 백업 알려줘', NOW, '2026-10-04T00:00'],
    ['정오에 점심 알려줘', NOW, '2026-10-03T12:00'], // today's noon passed
    ['정오에 점심 알려줘', at('2026-10-02T09:00'), '2026-10-02T12:00'],
    ['내일 정오에 점심 알려줘', NOW, '2026-10-03T12:00'],
    ['오전 12시에 백업 알려줘', NOW, '2026-10-03T00:00'],
    ['내일 오전 12시에 백업 알려줘', NOW, '2026-10-03T00:00'],
    ['오후 12시에 점심 알려줘', NOW, '2026-10-03T12:00'],
    // 자정 at 23:30 → in 30 minutes
    ['자정에 카운트다운 알려줘', at('2026-10-02T23:30'), '2026-10-03T00:00'],
  ])('%j at %s → %s', (message, now, local) => {
    expect(once(message, now).at).toBe(kst(local));
  });

  it('오늘 정오 after noon is past', () => {
    expect(parse('오늘 정오에 점심 알려줘')).toEqual({ kind: 'CLARIFY', reason: 'PAST_TIME' });
  });
});

describe('reminder grammar — KST calendar edges (month/year rollover, leap day)', () => {
  it.each([
    // month rollover
    ['내일 9시에 월초 정산 알려줘', at('2026-10-31T20:00'), '2026-11-01T09:00'],
    ['모레 9시에 회의 알려줘', at('2026-10-31T20:00'), '2026-11-02T09:00'],
    ['3시간 뒤에 확인 알려줘', at('2026-10-31T22:30'), '2026-11-01T01:30'],
    // year rollover
    ['내일 9시에 새해 인사 알려줘', at('2026-12-31T23:30'), '2027-01-01T09:00'],
    ['1월 1일 9시에 새해 인사 알려줘', NOW, '2027-01-01T09:00'], // month/day already passed this year → next year
    ['12월 31일 오후 11시 59분에 카운트다운 알려줘', NOW, '2026-12-31T23:59'],
    ['12월 31일 오후 11시 59분에 카운트다운 알려줘', at('2026-12-31T23:30'), '2026-12-31T23:59'],
    ['다음 주 월요일 9시에 회의 알려줘', at('2026-12-30T10:00'), '2027-01-04T09:00'],
    // leap day
    ['내일 9시에 윤일 알려줘', at('2028-02-28T10:00'), '2028-02-29T09:00'],
    ['2월 29일 9시에 윤일 알려줘', at('2027-10-02T14:00'), '2028-02-29T09:00'],
    ['2028년 2월 29일 9시에 윤일 알려줘', at('2027-10-02T14:00'), '2028-02-29T09:00'],
    ['내일 9시에 3월 시작 알려줘', at('2027-02-28T10:00'), '2027-03-01T09:00'],
  ])('%j at %s → %s', (message, now, local) => {
    expect(once(message, now).at).toBe(kst(local));
  });

  it.each([
    ['2월 30일 9시에 회의 알려줘', NOW, 'INVALID_DATE'],
    ['4월 31일 9시에 회의 알려줘', NOW, 'INVALID_DATE'],
    ['13월 1일 9시에 회의 알려줘', NOW, 'INVALID_DATE'],
    ['2월 29일 9시에 윤일 알려줘', NOW, 'INVALID_DATE'], // next 2월 29일 would be 2027, not a leap year
    ['2028년 2월 29일 9시에 윤일 알려줘', NOW, 'TOO_FAR'], // > 366 days ahead
    ['12월 31일 9시에 회의 알려줘', at('2026-12-31T23:30'), 'PAST_TIME'],
    ['2025년 12월 25일 9시에 회의 알려줘', NOW, 'PAST_TIME'],
  ] as const)('%j at %s → CLARIFY %s', (message, now, reason) => {
    expect(parse(message, now)).toEqual({ kind: 'CLARIFY', reason });
  });
});

describe('reminder grammar — recurring reminders', () => {
  const recurring = (text: string, now = NOW): { schedule: ReminderSchedule; at: string; body: string; kind: string } => {
    const r = parse(text, now);
    if (r.kind !== 'CREATE' || r.schedule.type === 'ONCE') throw new Error(`expected recurring CREATE for ${text}: ${JSON.stringify(r)}`);
    return { schedule: r.schedule, at: r.firstFireAt, body: r.body, kind: r.bodyKind };
  };

  it.each([
    ['매일 아침 8시에 오늘 할 일 알려줘', { type: 'DAILY', time: { hour: 8, minute: 0 } }, '2026-10-03T08:00', '오늘 할 일', 'BRIEF'],
    ['매일 9시에 약 먹기 알려줘', { type: 'DAILY', time: { hour: 9, minute: 0 } }, '2026-10-03T09:00', '약 먹기', 'TEXT'],
    ['매일 3시에 간식 알려줘', { type: 'DAILY', time: { hour: 15, minute: 0 } }, '2026-10-02T15:00', '간식', 'TEXT'],
    ['매일 자정에 일기 알려줘', { type: 'DAILY', time: { hour: 0, minute: 0 } }, '2026-10-03T00:00', '일기', 'TEXT'],
    ['평일 매일 9시에 스탠드업 알려줘', { type: 'WEEKLY', time: { hour: 9, minute: 0 }, weekdays: [1, 2, 3, 4, 5] }, '2026-10-05T09:00', '스탠드업', 'TEXT'],
    ['평일 오전 9시 30분에 스탠드업 알려줘', { type: 'WEEKLY', time: { hour: 9, minute: 30 }, weekdays: [1, 2, 3, 4, 5] }, '2026-10-05T09:30', '스탠드업', 'TEXT'],
    ['매주 월요일 오전 10시에 주간 회의 알려줘', { type: 'WEEKLY', time: { hour: 10, minute: 0 }, weekdays: [1] }, '2026-10-05T10:00', '주간 회의', 'TEXT'],
    ['매주 월, 수, 금 오전 7시에 운동 알려줘', { type: 'WEEKLY', time: { hour: 7, minute: 0 }, weekdays: [1, 3, 5] }, '2026-10-05T07:00', '운동', 'TEXT'],
    ['매주 월수금 7시에 운동 알려줘', { type: 'WEEKLY', time: { hour: 7, minute: 0 }, weekdays: [1, 3, 5] }, '2026-10-05T07:00', '운동', 'TEXT'],
    ['매주 화요일과 목요일 저녁 8시에 영어 알려줘', { type: 'WEEKLY', time: { hour: 20, minute: 0 }, weekdays: [2, 4] }, '2026-10-06T20:00', '영어', 'TEXT'],
    ['매주 금요일 오후 3시에 회고 알려줘', { type: 'WEEKLY', time: { hour: 15, minute: 0 }, weekdays: [5] }, '2026-10-02T15:00', '회고', 'TEXT'],
    ['토요일마다 10시에 청소 알려줘', { type: 'WEEKLY', time: { hour: 10, minute: 0 }, weekdays: [6] }, '2026-10-03T10:00', '청소', 'TEXT'],
    ['주말마다 9시에 산책 알려줘', { type: 'WEEKLY', time: { hour: 9, minute: 0 }, weekdays: [0, 6] }, '2026-10-03T09:00', '산책', 'TEXT'],
  ] as const)('%j', (message, schedule, local, body, kind) => {
    expect(recurring(message)).toEqual({ schedule, at: kst(local), body, kind });
  });

  it('the first occurrence is at least one minute ahead (otherwise the next one)', () => {
    expect(recurring('매일 14시에 회의 알려줘', at('2026-10-02T13:59:30')).at).toBe(kst('2026-10-03T14:00'));
    expect(recurring('매일 14시에 회의 알려줘', at('2026-10-02T13:58:59')).at).toBe(kst('2026-10-02T14:00'));
  });

  it('recurrences roll over year ends', () => {
    expect(recurring('매일 아침 8시에 운동 알려줘', at('2026-12-31T09:00')).at).toBe(kst('2027-01-01T08:00'));
  });

  it.each([
    '매시간 알려줘',
    '매 시간 물 마시기 알려줘',
    '30분마다 물 마시라고 알려줘',
    '2시간마다 스트레칭 알려줘',
    '매달 1일 9시에 월세 알려줘',
    '매월 9시에 정산 알려줘',
    '매년 9시에 생일 알려줘',
    '매주 9시에 알려줘',
    'remind me every hour to drink water',
    'remind me hourly to stretch',
    'remind me every 30 minutes to stretch',
    'remind me monthly at 9am to pay rent',
  ])('%j → CLARIFY UNSUPPORTED_RECURRENCE', (message) => {
    expect(parse(message)).toEqual({ kind: 'CLARIFY', reason: 'UNSUPPORTED_RECURRENCE' });
  });

  it('a recurrence combined with a day is ambiguous', () => {
    expect(parse('매일 내일 9시에 운동 알려줘')).toEqual({ kind: 'CLARIFY', reason: 'AMBIGUOUS_TIME' });
  });
});

describe('reminder grammar — clarify, never guess', () => {
  it.each([
    ['30분 뒤에 알려줘', 'EMPTY_BODY'],
    ['내일 9시에 알려줘', 'EMPTY_BODY'],
    ['오늘 오전 9시에 회의 알려줘', 'PAST_TIME'],
    ['오늘 1시에 회의 알려줘', 'PAST_TIME'],
    ['이번 주 수요일 3시에 회의 알려줘', 'PAST_TIME'],
    ['10월 2일 1시에 회의 알려줘', 'PAST_TIME'],
    ['30초 뒤에 테스트 알려줘', 'TOO_SOON'],
    ['0분 뒤에 테스트 알려줘', 'TOO_SOON'],
    ['367일 뒤에 갱신 알려줘', 'TOO_FAR'],
    ['3시에 회의 5시에 알려줘', 'AMBIGUOUS_TIME'],
    ['내일 회의 9시에 알려줘', 'AMBIGUOUS_TIME'], // the day sits outside the bound time
    ['내일 30분 뒤에 회의 알려줘', 'AMBIGUOUS_TIME'],
    ['내일에 회의 리마인드 해줘', 'MISSING_TIME'], // an explicit reminder verb with a day but no time
  ] as const)('%j → CLARIFY %s', (message, reason) => {
    expect(parse(message)).toEqual({ kind: 'CLARIFY', reason });
  });

  it.each([
    // A day reference the grammar does not resolve, next to a bare time, is never folded into the body while the
    // time is read as today's (now = Fri 2026-10-02 14:00 KST).
    ['15일 오후 3시에 회의 알려줘', 'AMBIGUOUS_TIME'],
    ['3일 9시에 회의 알려줘', 'AMBIGUOUS_TIME'],
    ['20일 오전 10시에 월세 알려줘', 'AMBIGUOUS_TIME'],
    ['회의 15일 3시에 알려줘', 'AMBIGUOUS_TIME'],
    ['다음 주 오후 3시에 보고 알려줘', 'AMBIGUOUS_TIME'],
    ['다음주 9시에 보고 알려줘', 'AMBIGUOUS_TIME'],
    ['이번 주 9시에 보고 알려줘', 'AMBIGUOUS_TIME'],
    ['다음 달 3일 9시에 회의 알려줘', 'AMBIGUOUS_TIME'],
    ['이번 달 9시에 정산 알려줘', 'AMBIGUOUS_TIME'],
    ['주말 9시에 청소 알려줘', 'AMBIGUOUS_TIME'],
    ['이번 주말 10시에 청소 알려줘', 'AMBIGUOUS_TIME'],
    ['다음 주말 10시에 캠핑 알려줘', 'AMBIGUOUS_TIME'],
    ['월말 9시에 정산 알려줘', 'AMBIGUOUS_TIME'],
    ['remind me on the 15th at 3pm to pay rent', 'AMBIGUOUS_TIME'],
    ['remind me next week at 9am to x', 'AMBIGUOUS_TIME'],
    ['remind me this weekend at 10am to clean', 'AMBIGUOUS_TIME'],
    ['remind me next month at 9am to renew', 'AMBIGUOUS_TIME'],
    ['remind me at the end of the month at 9am to pay', 'AMBIGUOUS_TIME'],
    ['remind me at 3pm friday to submit', 'AMBIGUOUS_TIME'], // a weekday not bound by on/next/this
  ] as const)('unsupported day reference: %j → CLARIFY %s', (message, reason) => {
    expect(parse(message)).toEqual({ kind: 'CLARIFY', reason });
  });

  it.each([
    // Durations and look-alikes are not day references.
    ['내일 9시에 3일치 약 챙기기 알려줘', '3일치 약 챙기기', '2026-10-03T09:00'],
    ['9시에 3일 동안 먹을 약 알려줘', '3일 동안 먹을 약', '2026-10-02T21:00'],
    ['9시에 다음 주제 발표 알려줘', '다음 주제 발표', '2026-10-02T21:00'],
    ['내일 9시에 다음 주 회의 준비 알려줘', '다음 주 회의 준비', '2026-10-03T09:00'], // the bound time has its own day
    ['30분 뒤에 주말 계획 정리 알려줘', '주말 계획 정리', '2026-10-02T14:30'],
    ["remind me at 9 to send friday's report", "send friday's report", '2026-10-02T21:00'],
    ['remind me tomorrow at 9am to plan next week', 'plan next week', '2026-10-03T09:00'],
  ])('%j → %j at %s', (message, body, local) => {
    expect(once(message)).toEqual({ body, at: kst(local), kind: 'TEXT' });
  });

  it.each([
    // A reminder request with a day but no clock asks for the time instead of falling through to chat.
    '내일 회의 리마인드 해줘',
    '리마인드 해줘 내일 회의',
    '다음 주 보고 리마인드 해줘',
    '15일 월세 알림 설정해줘',
    '아침에 약 리마인드 해줘',
    '내일 오전에 회의 알려줘',
    '모레 저녁에 운동 알려줘',
    '매일 아침에 약 먹으라고 알려줘',
    'remind me next week to call mom',
    'remind me on the 15th to pay rent',
  ])('%j → CLARIFY MISSING_TIME', (message) => {
    expect(parse(message)).toEqual({ kind: 'CLARIFY', reason: 'MISSING_TIME' });
  });

  it('a one-minute lead is allowed; less is TOO_SOON', () => {
    expect(once('오늘 14시 1분에 회의 알려줘', at('2026-10-02T14:00')).at).toBe(kst('2026-10-02T14:01'));
    expect(parse('오늘 14시에 회의 알려줘', at('2026-10-02T13:59:30'))).toEqual({ kind: 'CLARIFY', reason: 'TOO_SOON' });
  });

  it('366 days ahead is allowed; 367 is TOO_FAR', () => {
    expect(once('366일 뒤에 갱신 알려줘').at).toBe(kst('2027-10-03T14:00'));
  });

  it('body bounds: 200 code points fit, 201 are BODY_TOO_LONG', () => {
    expect(once(`내일 9시에 ${'가'.repeat(200)} 알려줘`).body).toBe('가'.repeat(200));
    expect(parse(`내일 9시에 ${'가'.repeat(201)} 알려줘`)).toEqual({ kind: 'CLARIFY', reason: 'BODY_TOO_LONG' });
    expect(parse(`remind me tomorrow at 9am to ${'a'.repeat(201)}`)).toEqual({ kind: 'CLARIFY', reason: 'BODY_TOO_LONG' });
  });
});

describe('reminder grammar — NOT_REMINDER corpus (falls through untouched)', () => {
  it.each([
    '',
    '   ',
    '내일 날씨 알려줘',
    '이 함수 뭐 하는지 알려줘',
    '30분 뒤에 알려주지 마',
    '30분 뒤에 알려 주지 마세요',
    '진행 상황 알려줘',
    '기억해: 내일 9시 회의',
    '오늘 할 일 알려줘',
    '할 일 목록 알려줘',
    '내일 회의 알려줘',
    '내일 9시 회의 알려줘', // the time is not bound by 에
    '점심에 뭐 먹을지 알려줘', // a meridiem alone is not a time
    '월요일에 뭐 있는지 알려줘', // a day alone needs an explicit reminder verb
    '어제 3시에 뭐 했는지 알려줘', // past reference: a question, not a reminder
    '지난주 금요일 3시에 무슨 회의였는지 알려줘',
    '3시간 전에 뭐라고 했는지 알려줘',
    '알림 목록 보여줘 좀', // LIST is whole-message only
    '알림 목록이 뭐야',
    '내일 9시에 회의 있어',
    '2시간 동안 회의했어 알려줘',
    '내일 9시에 알려줘 말고 그냥 메모해', // negated verb
    'remind me what we discussed',
    "don't remind me in 30 minutes",
    'do not remind me tomorrow at 9am',
    'remind me yesterday at 9am to call', // past reference
    'what time is it',
    'meeting at 3pm',
    'tell me about tomorrow at 9am',
    '내일 날씨 알려줘 오전에', // no day + part of day bound by 에, generic verb
    '내일 일정 알려줘',
    '저녁 메뉴 알려줘',
  ])('%j → NOT_REMINDER', (message) => {
    expect(parse(message)).toEqual({ kind: 'NOT_REMINDER' });
  });

  it('never throws for odd input', () => {
    for (const text of ['알려줘', '에', '9시에', '뒤에 알려줘', '9999999999시에 알려줘', '#'.repeat(5000), '\u0000알려줘', 'remind me at', 'remind me in']) {
      expect(() => parse(text)).not.toThrow();
    }
  });

  it('rejects an invalid now', () => {
    expect(() => parseReminderMessage('내일 9시에 회의 알려줘', { now: 'never' })).toThrow(RangeError);
  });
});

describe('reminder grammar — anchored to-do prefixes (closed ADR-0100 D1 list) are never reminders', () => {
  it('mirrors the ADR-0100 D1 list literally', () => {
    expect([...ANCHORED_TODO_PREFIX_HEADS]).toEqual([
      '할 일 추가',
      '할일 추가',
      '할 일 등록',
      '할일 등록',
      'todo add',
      'add todo',
      'to-do add',
      '완료 처리',
      '할 일 완료',
      '할일 완료',
      'todo done',
      '할 일 취소',
      '할일 취소',
      'todo cancel',
      '할 일 연결',
      '할일 연결',
      'todo link',
    ]);
  });

  it.each(ANCHORED_TODO_PREFIX_HEADS.map((head) => [head]))('%j: with a time phrase and 알려줘 → NOT_REMINDER', (head) => {
    for (const message of [
      `${head}: 내일 9시에 회의 알려줘`,
      `${head}：30분 뒤에 스트레칭 알려줘`,
      `  ${head} : remind me tomorrow at 9am to call mom`,
      `${head}:매일 아침 8시에 오늘 할 일 알려줘`,
    ]) {
      expect(startsWithAnchoredTodoPrefix(message)).toBe(true);
      expect(parse(message)).toEqual({ kind: 'NOT_REMINDER' });
    }
  });

  it('ASCII heads are case-insensitive', () => {
    expect(parse('TODO ADD: remind me tomorrow at 9am to call mom')).toEqual({ kind: 'NOT_REMINDER' });
    expect(parse('Add Todo: 내일 9시에 회의 알려줘')).toEqual({ kind: 'NOT_REMINDER' });
  });

  it('only the listed spacing variants and a colon anchor the message', () => {
    expect(startsWithAnchoredTodoPrefix('할일추가: 내일 9시에 회의 알려줘')).toBe(false);
    expect(startsWithAnchoredTodoPrefix('할 일 추가 내일 9시에 회의 알려줘')).toBe(false);
    expect(startsWithAnchoredTodoPrefix('오늘 할 일 추가: 회의')).toBe(false);
  });
});

describe('reminder grammar — daily brief bodies', () => {
  it.each(REMINDER_BRIEF_BODIES.map((body) => [body]))('%j is a BRIEF body', (body) => {
    expect(once(`내일 8시에 ${body} 알려줘`).kind).toBe('BRIEF');
  });

  it('only an exact brief body is BRIEF', () => {
    expect(once('내일 8시에 오늘 할 일 정리 알려줘').kind).toBe('TEXT');
    expect(parse('remind me every day at 8am about today’s tasks')).toMatchObject({ kind: 'CREATE', bodyKind: 'BRIEF' });
    expect(parse('remind me every day at 8am about the daily brief')).toMatchObject({ kind: 'CREATE', bodyKind: 'TEXT' });
  });
});

describe('reminder grammar — LIST and CANCEL (whole message)', () => {
  it.each(['알림 목록', '알림목록', '리마인더 목록', '내 알림', '내 알림 목록', '알림 리스트', '알림 목록 보여줘', '알림 목록?', 'list reminders', 'List my reminders', 'show reminders', 'my reminders'])(
    '%j → LIST',
    (message) => {
      expect(parse(message)).toEqual({ kind: 'LIST' });
    },
  );

  it.each([
    ['알림 3 취소', 3],
    ['알림 #3 취소', 3],
    ['알림 3번 취소', 3],
    ['알림 12 취소해줘', 12],
    ['알림 3 취소 해 주세요', 3],
    ['리마인더 4 취소', 4],
    ['#5 알림 취소', 5],
    ['cancel reminder 4', 4],
    ['Cancel reminder #7', 7],
    ['알림 007 취소', 7],
  ] as const)('%j → CANCEL #%i', (message, displayNo) => {
    expect(parse(message)).toEqual({ kind: 'CANCEL', displayNo });
  });

  it.each([
    ['알림 0 취소', 'INVALID_REMINDER_NUMBER'],
    ['알림 취소', 'INVALID_REMINDER_NUMBER'],
    ['cancel reminder', 'INVALID_REMINDER_NUMBER'],
    ['알림 모두 취소', 'BULK_CANCEL_UNSUPPORTED'],
    ['모든 알림 취소해줘', 'BULK_CANCEL_UNSUPPORTED'],
    ['알림 전부 다 취소', 'BULK_CANCEL_UNSUPPORTED'],
    ['cancel all reminders', 'BULK_CANCEL_UNSUPPORTED'],
  ] as const)('%j → CLARIFY %s', (message, reason) => {
    expect(parse(message)).toEqual({ kind: 'CLARIFY', reason });
  });

  it.each(['알림 3 취소하지 마', '알림 3 취소는 어떻게 해', 'please cancel reminder 3 later', '알림 3'])('%j → NOT_REMINDER', (message) => {
    expect(parse(message)).toEqual({ kind: 'NOT_REMINDER' });
  });
});

describe('reminder grammar — English', () => {
  it.each([
    ['remind me tomorrow at 9am to call mom', 'call mom', '2026-10-03T09:00'],
    ['remind me tomorrow at 9 to call mom', 'call mom', '2026-10-03T09:00'],
    ['remind me tomorrow at 3 to call mom', 'call mom', '2026-10-03T15:00'],
    ['remind me to call mom tomorrow at 9am', 'call mom', '2026-10-03T09:00'],
    ['remind me in 45 minutes to stretch', 'stretch', '2026-10-02T14:45'],
    ['remind me in an hour to stretch', 'stretch', '2026-10-02T15:00'],
    ['remind me in 1 hour and 30 minutes to stretch', 'stretch', '2026-10-02T15:30'],
    ['remind me in half an hour to stretch', 'stretch', '2026-10-02T14:30'],
    ['remind me in 2 days to renew', 'renew', '2026-10-04T14:00'],
    ['remind me at 5pm to leave', 'leave', '2026-10-02T17:00'],
    ['remind me at 5:30 p.m. to leave', 'leave', '2026-10-02T17:30'],
    ['remind me at 9 to take pills', 'take pills', '2026-10-02T21:00'], // bare → nearest future
    ['remind me at 21:00 to take pills', 'take pills', '2026-10-02T21:00'],
    ['remind me at noon to eat', 'eat', '2026-10-03T12:00'],
    ['remind me at midnight to back up', 'back up', '2026-10-03T00:00'],
    ['remind me tonight at 9 to call', 'call', '2026-10-02T21:00'],
    ['remind me tomorrow at 9 in the morning about the meeting', 'the meeting', '2026-10-03T09:00'],
    ['remind me next monday at 3 to submit', 'submit', '2026-10-05T15:00'],
    ['remind me on Monday at 10am to vote', 'vote', '2026-10-05T10:00'],
    ['remind me this sunday at 11am to shop', 'shop', '2026-10-04T11:00'],
    ['remind me on October 5 at 10am to vote', 'vote', '2026-10-05T10:00'],
    ['remind me on 5th October at 10am to vote', 'vote', '2026-10-05T10:00'],
    ['remind me on Jan 1 at 9am to say happy new year', 'say happy new year', '2027-01-01T09:00'],
    ['remind me on 2026-10-05 at 9am to file', 'file', '2026-10-05T09:00'],
    ['Remind me tomorrow at 9AM to call mom.', 'call mom', '2026-10-03T09:00'],
    ['please remind me tomorrow at 9am about the dentist', 'the dentist', '2026-10-03T09:00'],
    ['can you remind me at 9pm to x', 'x', '2026-10-02T21:00'],
    ['Could you please remind me at 9pm to water the plants?', 'water the plants', '2026-10-02T21:00'],
    ['hey, can you remind me tomorrow at 9am to call mom', 'call mom', '2026-10-03T09:00'],
    ['pls remind me in 45 minutes to stretch', 'stretch', '2026-10-02T14:45'],
    ['remind me at 9 that so and so is coming', 'so and so is coming', '2026-10-02T21:00'], // only text before the verb is a lead-in
  ])('%j → %j at %s', (message, body, local) => {
    expect(once(message)).toEqual({ body, at: kst(local), kind: 'TEXT' });
  });

  it.each([
    ['every weekday at 8:30 remind me to stretch', { type: 'WEEKLY', time: { hour: 8, minute: 30 }, weekdays: [1, 2, 3, 4, 5] }, '2026-10-05T08:30'],
    ['remind me every day at 8am to run', { type: 'DAILY', time: { hour: 8, minute: 0 } }, '2026-10-03T08:00'],
    ['remind me daily at 3 to snack', { type: 'DAILY', time: { hour: 15, minute: 0 } }, '2026-10-02T15:00'],
    ['remind me every monday and wednesday at 7pm to study', { type: 'WEEKLY', time: { hour: 19, minute: 0 }, weekdays: [1, 3] }, '2026-10-05T19:00'],
    ['remind me every weekend at 10am to clean', { type: 'WEEKLY', time: { hour: 10, minute: 0 }, weekdays: [0, 6] }, '2026-10-03T10:00'],
  ] as const)('%j', (message, schedule, local) => {
    expect(parse(message)).toMatchObject({ kind: 'CREATE', schedule, firstFireAt: kst(local) });
  });

  it.each([
    ['remind me in 45 minutes', 'EMPTY_BODY'],
    ['remind me tomorrow to call mom', 'MISSING_TIME'],
    ['remind me every day to run', 'MISSING_TIME'],
    ['remind me today at 9am to call', 'PAST_TIME'],
    ['remind me in 30 seconds to test', 'TOO_SOON'],
    ['remind me in 400 days to renew', 'TOO_FAR'],
    ['remind me on February 30 at 9am to x', 'INVALID_DATE'],
    ['remind me at 13pm to x', 'INVALID_TIME'],
    ['remind me tomorrow at 9am and at 5pm to x', 'AMBIGUOUS_TIME'],
  ] as const)('%j → CLARIFY %s', (message, reason) => {
    expect(parse(message)).toEqual({ kind: 'CLARIFY', reason });
  });
});

describe('reminder grammar — time zones other than Asia/Seoul', () => {
  const NY = 'America/New_York';

  it('resolves wall-clock times in the configured zone', () => {
    // 2026-10-02T05:00Z = 01:00 EDT Friday
    expect(parse('remind me tomorrow at 9am to call mom', NOW, NY)).toMatchObject({
      kind: 'CREATE',
      firstFireAt: '2026-10-03T13:00:00.000Z',
      timeZone: NY,
    });
  });

  it('a one-time reminder in a DST gap is NONEXISTENT_TIME; a recurring one fires the gap length later', () => {
    const now = '2026-03-07T17:00:00.000Z'; // 12:00 EST, Saturday
    expect(parse('내일 오전 2시 30분에 점검 알려줘', now, NY)).toEqual({ kind: 'CLARIFY', reason: 'NONEXISTENT_TIME' });
    expect(parse('매일 오전 2시 30분에 점검 알려줘', now, NY)).toMatchObject({
      kind: 'CREATE',
      schedule: { type: 'DAILY', time: { hour: 2, minute: 30 } },
      firstFireAt: '2026-03-08T07:30:00.000Z', // 03:30 EDT
    });
  });

  it('a one-time reminder in a DST overlap uses the earlier instant', () => {
    const now = '2026-10-31T16:00:00.000Z'; // 12:00 EDT, Saturday
    expect(parse('내일 오전 1시 30분에 점검 알려줘', now, NY)).toMatchObject({
      kind: 'CREATE',
      firstFireAt: '2026-11-01T05:30:00.000Z', // 01:30 EDT
    });
  });
});

describe('reminder grammar — every clarify reason is reachable', () => {
  const reasons: ReminderClarifyReason[] = [
    'PAST_TIME',
    'INVALID_DATE',
    'INVALID_TIME',
    'NONEXISTENT_TIME',
    'TOO_FAR',
    'TOO_SOON',
    'UNSUPPORTED_RECURRENCE',
    'MISSING_TIME',
    'AMBIGUOUS_TIME',
    'EMPTY_BODY',
    'BODY_TOO_LONG',
    'INVALID_REMINDER_NUMBER',
    'BULK_CANCEL_UNSUPPORTED',
  ];
  const examples: Array<[string, string?, string?]> = [
    ['오늘 오전 9시에 회의 알려줘'],
    ['2월 30일 9시에 회의 알려줘'],
    ['내일 25시에 확인 알려줘'],
    ['내일 오전 2시 30분에 점검 알려줘', '2026-03-07T17:00:00.000Z', 'America/New_York'],
    ['367일 뒤에 갱신 알려줘'],
    ['30초 뒤에 테스트 알려줘'],
    ['매시간 알려줘'],
    ['remind me tomorrow to call mom'],
    ['3시에 회의 5시에 알려줘'],
    ['30분 뒤에 알려줘'],
    [`내일 9시에 ${'가'.repeat(201)} 알려줘`],
    ['알림 0 취소'],
    ['알림 모두 취소'],
  ];

  it('covers the closed set', () => {
    const seen = new Set(
      examples.map(([text, now, zone]) => {
        const r = parse(text, now ?? NOW, zone);
        return r.kind === 'CLARIFY' ? r.reason : r.kind;
      }),
    );
    expect([...seen].sort()).toEqual([...reasons].sort());
  });
});
