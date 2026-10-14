import { describe, expect, it } from 'vitest';
import type { NlCatalogEntry } from './catalog';
import { validateSelection, type NlValidationContext } from './selection-validator';
import { nlExpressedWeekday, resolveNlRange } from './symbolic-time';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 A5 implementation note 2 (live Telegram 2026-10-14): "다음 주 수 일정 있어?" was answered with next Monday.
// A one-syllable weekday (월 화 수 목 금 토 일) is a weekday only right after a week anchor, and a period that drops or
// changes the one weekday the owner named never validates. Paraphrased phrases; no real names.

const TZ = 'Asia/Seoul';
const NOW = '2026-10-14T06:52:00.000Z'; // Wednesday 2026-10-14 15:52 in Asia/Seoul (the live turn)
const ALL: readonly NlCatalogEntry[] = Object.values(NL_WAVE1_ENTRIES);

function ctx(groundingText: string, extra: Partial<NlValidationContext> = {}): NlValidationContext {
  return { offered: new Map(ALL.map((entry) => [entry.id, entry] as const)), groundingText, now: NOW, timeZone: TZ, ...extra };
}
const calendar = (text: string, range?: string) =>
  validateSelection({ entryId: 'calendar.events', args: range === undefined ? {} : { range } }, ctx(text));

const ABBREVIATIONS = [
  ['월', 1, 'mon'],
  ['화', 2, 'tue'],
  ['수', 3, 'wed'],
  ['목', 4, 'thu'],
  ['금', 5, 'fri'],
  ['토', 6, 'sat'],
  ['일', 0, 'sun'],
] as const;
const ANCHORS = [
  ['다음 주', 'next'],
  ['다음주', 'next'],
  ['담주', 'next'],
  ['차주', 'next'],
  ['이번 주', 'this'],
  ['이번주', 'this'],
  ['금주', 'this'],
  ['지난주', 'last'],
  ['지난 주', 'last'],
  ['저번 주', 'last'],
  ['다다음 주', 'after-next'],
  ['다다음주', 'after-next'],
] as const;
/** The symbol of that day for an anchor; the week after next has none, so its day is a date. */
function symbolFor(week: string, stem: string, index: number): string {
  if (week === 'after-next') {
    const day = new Date(Date.UTC(2026, 9, 26 + ((index + 6) % 7))); // Monday 10/26 of the week after next
    return `${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
  }
  return `${week}-${stem}`;
}

describe('a one-syllable weekday after a week anchor names that weekday', () => {
  for (const [anchor, week] of ANCHORS) {
    it.each(ABBREVIATIONS)(`${anchor} %s 일정 있어?`, (syllable, index, stem) => {
      const text = `${anchor} ${syllable} 일정 있어?`;
      expect(nlExpressedWeekday(text)).toEqual({
        weekday: index,
        certain: syllable !== '일',
        bound: false,
        week,
        abbreviations: syllable === '일' ? [] : [syllable],
      });
      const symbol = symbolFor(week, stem, index);
      const right = calendar(text, symbol);
      expect(right, symbol).toMatchObject({ ok: true });
      if (right.ok) expect(right.value.range?.days).toBe(1);
      // A different day of that week is never accepted (the live defect: 수 answered with Monday).
      const wrongStem = stem === 'mon' ? 'tue' : 'mon';
      const wrongIndex = stem === 'mon' ? 2 : 1;
      expect(calendar(text, symbolFor(week, wrongStem, wrongIndex))).toMatchObject({ ok: false, reason: 'weekday', arg: 'range' });
    });
  }

  it.each(['수에', '수엔', '수는', '수도', '수만', '수까지', '수랑'])('the abbreviation takes one closed particle: 다음 주 %s', (word) => {
    expect(nlExpressedWeekday(`다음 주 ${word} 뭐 있어`)).toMatchObject({ weekday: 3, week: 'next' });
  });

  it('the live defect: next Monday, the whole week, this week and today are all refused; next Wednesday is the answer', () => {
    const text = '다음 주 수 일정 있어?';
    expect(calendar(text, 'next-wed')).toMatchObject({ ok: true, value: { range: { startDate: { year: 2026, month: 10, day: 21 }, days: 1 } } });
    expect(calendar(text, '10-21')).toMatchObject({ ok: true });
    for (const range of ['next-mon', 'next-week', 'this-wed', 'wed', 'next-7-days', 'upcoming', undefined]) {
      expect(calendar(text, range), String(range)).toMatchObject({ ok: false, reason: 'weekday', entryId: 'calendar.events', arg: 'range' });
    }
  });

  it('the full weekday names keep working and get the same guard, with and without an anchor', () => {
    expect(calendar('다음 주 수요일 오후에 뭐 있어', 'next-wed')).toMatchObject({ ok: true });
    expect(calendar('다음주수요일 일정', 'next-wed')).toMatchObject({ ok: true });
    expect(calendar('다음 주 수요일 일정', 'next-week')).toMatchObject({ ok: false, reason: 'weekday' });
    expect(calendar('다다음 주 수요일 일정', 'week-after-next')).toMatchObject({ ok: false, reason: 'weekday' });
    expect(calendar('금요일 일정 뭐야?', 'fri')).toMatchObject({ ok: true });
    expect(calendar('금요일 일정 뭐야?', 'next-fri')).toMatchObject({ ok: true });
    expect(calendar('금요일 일정 뭐야?', 'thu')).toMatchObject({ ok: false, reason: 'weekday' });
    expect(calendar('am I busy on Friday?', 'fri')).toMatchObject({ ok: true });
    expect(calendar('am I busy on Friday?', 'this-week')).toMatchObject({ ok: false, reason: 'weekday' });
    expect(validateSelection({ entryId: 'calendar.events', args: { range: 'this-thu' } }, ctx('목요일 거는?', { previousArgs: { range: 'this-week' } }))).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'calendar.events', args: { range: 'this-week' } }, ctx('목요일 거는?', { previousArgs: { range: 'this-week' } }))).toMatchObject({ ok: false, reason: 'weekday' });
  });

  it('a weekday that bounds a period ("까지", "부터", "by") must fall inside the period, not be it', () => {
    const jira = (text: string, range: string) => validateSelection({ entryId: 'jira.issues', args: { window: 'due', range } }, ctx(text));
    expect(jira('이번 주 금요일까지인 이슈들 알려줄래', 'this-week')).toMatchObject({ ok: true });
    expect(jira('이번 주 금까지 마감인 이슈', 'this-week')).toMatchObject({ ok: true });
    expect(jira('이번 주 금까지 마감인 이슈', 'this-fri')).toMatchObject({ ok: true });
    expect(jira('issues due by Friday', 'next-7-days')).toMatchObject({ ok: true });
    expect(jira('이번 주 금까지 마감인 이슈', 'last-week')).toMatchObject({ ok: false, reason: 'weekday' });
  });

  it('a weekday abbreviation is never a title keyword', () => {
    expect(validateSelection({ entryId: 'calendar.events', args: { range: 'next-wed', keyword: '수' } }, ctx('다음 주 수 일정 있어?'))).toMatchObject({
      ok: false,
      reason: 'time-keyword',
      arg: 'keyword',
    });
  });
});

describe('elsewhere 수, 일, 금 and 월 keep their other meanings', () => {
  it.each([
    '할 일 다 보여줘',
    '남은 수 알려줘',
    '할 일 남은 수 알려줘',
    '3월 일정',
    '1일 일정',
    '금 시세',
    '이번 주 일정',
    '다음 주 일정 있어?',
    '이번 주말 일정',
    '이번 주 수업 일정',
    '다음 주 월간 보고',
    '지난주 금액 정리',
    '오늘 일 많아?',
    '수 일정',
    '금 일정',
    '이번 달 일정',
    'next month',
  ])('%s names no weekday', (text) => {
    expect(nlExpressedWeekday(text)).toBeUndefined();
  });

  it('those texts validate exactly as before (no guard)', () => {
    expect(calendar('3월 일정', '03-01..03-31')).toMatchObject({ ok: true });
    expect(calendar('1일 일정', '11-01')).toMatchObject({ ok: true });
    expect(calendar('이번 주 일정', 'this-week')).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'todo.list', args: {} }, ctx('할 일 다 보여줘'))).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'jira.issues', args: {} }, ctx('남은 수 알려줘'))).toMatchObject({ ok: true });
  });

  it('"다음 주 일 많아?": 일 may be work or Sunday, so the week or Sunday are accepted, never another day', () => {
    const text = '다음 주 일 많아?';
    expect(nlExpressedWeekday(text)).toMatchObject({ weekday: 0, certain: false, week: 'next', abbreviations: [] });
    expect(calendar(text, 'next-week')).toMatchObject({ ok: true });
    expect(calendar(text, 'next-sun')).toMatchObject({ ok: true });
    expect(calendar(text, 'next-mon')).toMatchObject({ ok: false, reason: 'weekday' });
    expect(validateSelection({ entryId: 'jira.issues', args: {} }, ctx(text))).toMatchObject({ ok: true });
  });

  it('two weekdays name no single day, so the guard steps aside ("토, 일", "월~수", "수요일이랑 목요일")', () => {
    for (const text of ['다음 주 토, 일 일정', '다음 주 토 일 일정', '다음 주 월~수 일정', '수요일이랑 목요일 일정', '월요일부터 수요일까지']) {
      expect(nlExpressedWeekday(text), text).toBeUndefined();
    }
    expect(calendar('다음 주 토, 일 일정', 'next-weekend')).toMatchObject({ ok: true });
  });

  it('a sender named like a weekday is a name, not a period', () => {
    expect(validateSelection({ entryId: 'mail.list', args: { from: '월요일' } }, ctx('월요일 씨 메일'))).toMatchObject({ ok: true });
  });

  it('the resolver itself is unchanged: next-wed is 10/21 and next-mon is 10/19 from Wednesday 10/14', () => {
    expect(resolveNlRange('next-wed', NOW, TZ)).toMatchObject({ startDate: { month: 10, day: 21 }, days: 1 });
    expect(resolveNlRange('next-mon', NOW, TZ)).toMatchObject({ startDate: { month: 10, day: 19 }, days: 1 });
  });
});
