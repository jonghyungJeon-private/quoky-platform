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

  it('an unquoted title in an update / delete reference becomes lower-cased title words (live 2026-11-16)', () => {
    expect(parse('내일 Quoky E2E 되돌리기 시험 일정 삭제해줘')).toMatchObject({
      kind: 'calendar-delete',
      ref: { titleWords: ['quoky', 'e2e', '되돌리기', '시험'] },
    });
    expect(parse('내일 Quoky E2E 되돌리기 시험 일정을 삭제해줘')).toMatchObject({ ref: { titleWords: ['quoky', 'e2e', '되돌리기', '시험'] } });
    expect(parse('내일 오후 3시 Quoky E2E 시험 일정 취소해줘')).toMatchObject({
      kind: 'calendar-delete',
      ref: { startTime: { hour: 15, minute: 0 }, titleWords: ['quoky', 'e2e', '시험'] },
    });
    expect(parse('내일 3시 Quoky 시험 일정 4시로 옮겨줘')).toMatchObject({
      kind: 'calendar-update',
      ref: { startTime: { hour: 15, minute: 0 }, titleWords: ['quoky', '시험'] },
      changes: { moveTo: { time: { hour: 16, minute: 0 } } },
    });
    // Quoted words are unchanged; a bare generic noun and a stranded deictic add no word; an undated reference adds none.
    expect(parse('내일 "Quoky 시험" 일정 삭제해줘')).toMatchObject({ ref: { titleWords: ['quoky', '시험'] } });
    expect(parse('내일 그 일정 삭제해줘')).toMatchObject({ ref: { titleWords: [] } });
    // Every day expression the read grammar knows (relative, past, week-qualified) is never a title word.
    for (const text of ['금일 일정 삭제해줘', '어제 일정 삭제해줘', '모레 회의 취소해줘', '다음 주 월요일 일정 삭제해줘']) {
      expect(parse(text), text).toMatchObject({ kind: 'calendar-delete', ref: { titleWords: [] } });
    }
    expect(parse('어제 Quoky 시험 일정 삭제해줘')).toMatchObject({ ref: { titleWords: ['quoky', '시험'] } });
    expect(parse('방금 그 Quoky E2E 시험 일정 취소해줘')).toMatchObject({ ref: { inferredDay: true, titleWords: [] } });
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

  it.each([
    ['금요일 오후 3시에 QA 스윕 회의 잡아줘', 'QA 스윕 회의'],
    ['내일 오후 2시에 주간 플랫폼 회의 넣어줘', '주간 플랫폼 회의'],
    ['내일 3시에 고객사 미팅을 잡아줘', '고객사 미팅'],
    ['내일 오전 10시에 팀 회의 일정 추가해줘', '팀 회의'],
    ['내일 3시에 2시간짜리 설계 리뷰 회의 잡아줘', '설계 리뷰 회의'],
    ['내일 3시에 회의 좀 잡아줘', '회의'],
    // The time phrase after the noun: no phrase between time and verb → the meeting noun, as before.
    ['QA 회의 내일 3시에 잡아줘', '회의'],
    // A quoted title and an explicit 제목 field still win over the phrase.
    ['내일 3시에 "설계 리뷰" 회의 잡아줘', '설계 리뷰'],
    ['내일 3시에 QA 회의 잡아줘 제목 주간 회의', '주간 회의'],
    // Live UAT 2026-11-03: when the trailing generic "일정" is the only meeting noun, the title keeps the owner's words.
    ['내일 오후 3시에 30분짜리 Quoky E2E 되돌리기 테스트 일정 추가해줘', 'Quoky E2E 되돌리기 테스트 일정'],
    ['내일 오후 3시에 중요한 일정 잡아줘', '중요한 일정'],
    // Live 2026-11-16: the title written BEFORE the duration / range is still the owner's residual span.
    ['내일 오후 3시에 Quoky E2E 되돌리기 시험 일정 30분짜리 추가해줘', 'Quoky E2E 되돌리기 시험 일정'],
    ['내일 오후 3시에 Quoky E2E 되돌리기 시험 일정 1시간 동안 추가해줘', 'Quoky E2E 되돌리기 시험 일정'],
    ['내일 오후 3시부터 4시까지 Quoky E2E 시험 일정 추가해줘', 'Quoky E2E 시험 일정'],
    ['내일 오후 3시에 30분 동안 Quoky E2E 시험 일정 추가해줘', 'Quoky E2E 시험 일정'],
    // Pins from the review rounds: these keep origin/main's titles.
    ['내일 3시에 3분기 실적 회의 잡아줘', '3분기 실적 회의'],
    ['내일 오후 3시에 30분 거리 카페 미팅 추가해줘', '30분 거리 카페 미팅'],
    ['내일 3시에 회의를 2시간 정도 잡아줘', '회의'],
  ])('create title (live QA D10): "%s" → "%s"', (text, title) => {
    expect(parse(text)).toMatchObject({ kind: 'calendar-create', event: { title } });
  });

  it('a change or delete that names no day is marked inferredDay (live QA D2); a named day is not', () => {
    expect(parse('일정 취소해줘')).toMatchObject({ kind: 'calendar-delete', ref: { inferredDay: true, titleWords: [] } });
    expect(parse('회의 취소해줘')).toMatchObject({ kind: 'calendar-delete', ref: { inferredDay: true } });
    expect(parse('5시 일정 삭제해줘')).toMatchObject({ kind: 'calendar-delete', ref: { inferredDay: true, startTime: { hour: 17, minute: 0 } } });
    expect(parse('회의 4시로 옮겨줘')).toMatchObject({ kind: 'calendar-update', ref: { inferredDay: true } });
    for (const text of ['오늘 회의 취소해줘', '내일 일정 취소해줘', '금요일 3시 회의 삭제해줘', '10월 9일 회의 취소해줘']) {
      const draft = parse(text);
      expect(draft.kind, text).toBe('calendar-delete');
      expect(draft.kind === 'calendar-delete' && draft.ref.inferredDay, text).toBeUndefined();
    }
  });

  it('never throws', () => {
    for (const text of ['', '   ', '내일', '\u0000', '가'.repeat(5000)]) expect(() => parse(text)).not.toThrow();
  });
});

describe('field labels are structural, not words (v5 title-grammar residual)', () => {
  const HOUR = timed('2026-10-07T06:00:00.000Z', '2026-10-07T07:00:00.000Z');
  const HALF = timed('2026-10-07T06:00:00.000Z', '2026-10-07T06:30:00.000Z');
  const draftOf = (text: string) => {
    const draft = parse(text);
    return draft.kind === 'calendar-create' ? draft.event : draft;
  };

  it('a bare 제목 inside the owner title is a title word, and the duration is read', () => {
    expect(draftOf('내일 오후 3시에 Quoky E2E 제목 시험 일정 30분짜리 추가해줘')).toEqual({ title: 'Quoky E2E 제목 시험 일정', time: HALF });
    expect(draftOf('내일 오후 3시에 Quoky E2E 제목 시험 일정 추가해줘')).toEqual({ title: 'Quoky E2E 제목 시험 일정', time: HOUR });
    // The literal live sentence names no time: nothing is invented, the title is never cut.
    const literal = draftOf('Quoky E2E 제목 시험 일정 30분짜리 추가해줘');
    expect(literal).not.toMatchObject({ title: '시험 일정 30분짜리' });
    expect(literal).not.toMatchObject({ title: '시험 일정' });
  });

  it.each([
    ['내일 오후 3시에 회의 잡아줘 제목 주간 회의 장소 3층', { title: '주간 회의', location: '3층', time: HOUR }],
    ['제목 주간 회의 내일 오후 3시에 잡아줘', { title: '주간 회의', time: HOUR }],
    ['내일 오후 3시에 회의 잡아줘 제목은 주간 회의', { title: '주간 회의', time: HOUR }],
    ['내일 오후 3시에 회의 잡아줘 제목: 주간 회의', { title: '주간 회의', time: HOUR }],
    ['내일 오후 3시에 회의 잡아줘 제목을 주간 회의로 잡아줘', { title: '주간 회의', time: HOUR }],
    ['내일 오후 3시에 회의 잡아줘 위치 3층', { title: '회의', location: '3층', time: HOUR }],
    ['내일 오후 3시에 회의 잡아줘 장소: 3층 설명 분기 계획 메모 자료 지참', { title: '회의', location: '3층', description: '분기 계획', time: HOUR }],
    ['내일 오후 3시에 회의 잡아줘 메모 자료 지참', { title: '회의', description: '자료 지참', time: HOUR }],
  ])('labelled form keeps working: "%s"', (text, event) => {
    expect(draftOf(text)).toEqual(event);
  });

  it('a labelled title still gets time and duration stripping', () => {
    expect(draftOf('내일 오후 3시에 회의 잡아줘 제목 주간 회의 30분짜리')).toEqual({ title: '주간 회의', time: HALF });
    // Recorded residual R-TG1: a bare label between the time and the booking verb is a title word (fails closed: the preview shows it).
    expect(draftOf('내일 오후 3시에 회의 제목 주간 회의 30분짜리 추가해줘')).toEqual({ title: '회의 제목 주간 회의', time: HALF });
    expect(draftOf('내일 회의 잡아줘 제목 주간 회의 오후 3시부터 4시까지')).toEqual({ title: '주간 회의', time: HOUR });
    // Decision: a colon / particle label keeps its value verbatim (as on main); only a bare label's trailing time run is cut.
    expect(draftOf('내일 오후 3시에 회의 잡아줘 제목: 주간 회의 30분짜리')).toEqual({ title: '주간 회의 30분짜리', time: HOUR });
  });

  it('a colon / particle labelled title stays verbatim, and a bare one never loses a day or time word inside a token', () => {
    expect(draftOf('내일 오후 3시에 회의 잡아줘 제목: 오늘의 회고')).toEqual({ title: '오늘의 회고', time: HOUR });
    expect(draftOf('내일 오후 3시에 회의 잡아줘 제목: 2시간 집중 세션')).toEqual({ title: '2시간 집중 세션', time: HOUR });
    expect(draftOf('내일 오후 3시에 회의 잡아줘 제목 종일 워크숍 준비')).toEqual({ title: '종일 워크숍 준비', time: HOUR });
    expect(draftOf('내일 오후 3시에 회의 잡아줘 제목: 3/4분기 리뷰')).toEqual({ title: '3/4분기 리뷰', time: HOUR });
    expect(draftOf('내일 오후 3시에 회의 잡아줘 제목 오늘의 회고')).toEqual({ title: '오늘의 회고', time: HOUR });
    expect(draftOf('내일 오후 3시에 회의 잡아줘 제목 3/4분기 리뷰')).toEqual({ title: '3/4분기 리뷰', time: HOUR });
  });

  it.each(['제목', '장소', '위치', '설명', '메모'])('a %s inside a compound word is never a label', (word) => {
    expect(draftOf(`내일 오후 3시에 새${word}시험 회의 잡아줘`)).toEqual({ title: `새${word}시험 회의`, time: HOUR });
    expect(draftOf(`내일 오후 3시에 ${word}시험 일정 추가해줘`)).toEqual({ title: `${word}시험 일정`, time: HOUR });
  });

  it('negated and fused attributive forms stay chat (R-TG2: fail closed)', () => {
    for (const text of [
      '존재하지않는제목 일정 삭제해줘',
      '내일 존재하지않는제목 일정 삭제해줘',
      '일정 삭제하지 않았어',
      '내일 회의 취소하지 않는다고 했어',
      '내일 회의 취소 안 해',
      '내일 3시 회의 취소해줘가 작동하지 않는데요',
      '일정 삭제해줘 기능이 동작하지 않는건가요',
      '내일 회의 취소하지 않는다면 일정 삭제해줘',
      '내일 일정 삭제해줘 같은 요청은 하지않는데요',
      '내일 일정 삭제해줘 하지않는데요 확인해줘',
      '취소하지않는다면 일정 삭제해줘',
    ]) {
      expect(isCalendarWriteRequest(text), text).toBe(false);
    }
  });

  it('a bare label value peels the trailing time run, then at most one booking request (review rounds 3-4)', () => {
    expect(draftOf('제목 QA 일정으로 잡아줘 내일 오후 3시에')).toEqual({ title: 'QA 일정', time: HOUR });
    expect(draftOf('제목 QA 일정으로 잡아줘 내일 오후 3시에 30분짜리')).toEqual({ title: 'QA 일정', time: HALF });
    // A generic -해줘 ending inside the title is title content, never peeled.
    expect(draftOf('내일 오후 3시에 일정 잡아줘 제목 구해줘 30분짜리')).toEqual({ title: '구해줘', time: HALF });
  });

  it('a participle before the title is not the booking verb', () => {
    expect(draftOf('내일 오후 3시에 넣어둔 제목 정리 회의 잡아줘')).toEqual({ title: '넣어둔 제목 정리 회의', time: HOUR });
  });

  it('an undated reference keeps empty title words (#342 rule: it resolves against the session context)', () => {
    expect(parse('방금 추가한 일정 취소해줘')).toMatchObject({ kind: 'calendar-delete', ref: { inferredDay: true, titleWords: [] } });
    expect(parse('일정 취소해줘')).toMatchObject({ ref: { inferredDay: true, titleWords: [] } });
  });
});
