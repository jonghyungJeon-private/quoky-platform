import { describe, expect, it } from 'vitest';
import type { NlArgs, NlCatalogEntry } from './catalog';
import { buildSelectionPrompt } from './selection-prompt';
import { validateSelection, type NlValidationContext } from './selection-validator';
import { nlCanonicalWeekdaySymbol, nlExpressedWeekday } from './symbolic-time';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// Calendar-accuracy implementation note (2026-10-14): a weekday symbol that names the same day as the owner's own week
// word is spelled the owner's way, so `this-fri` for "금요일" on a Wednesday is the canonical `fri`. Never another day.
// Paraphrased phrases; no real names.

const TZ = 'Asia/Seoul';
const WEDNESDAY = '2026-10-14T06:52:00.000Z'; // Wednesday 2026-10-14 15:52 in Asia/Seoul
const SATURDAY = '2026-10-17T03:00:00.000Z';
const ALL: readonly NlCatalogEntry[] = Object.values(NL_WAVE1_ENTRIES);

function ctx(groundingText: string, extra: Partial<NlValidationContext> = {}): NlValidationContext {
  return { offered: new Map(ALL.map((entry) => [entry.id, entry] as const)), groundingText, now: WEDNESDAY, timeZone: TZ, ...extra };
}
function argsOf(entryId: 'calendar.events' | 'jira.issues' | 'mail.list', text: string, args: NlArgs, extra: Partial<NlValidationContext> = {}): NlArgs | string {
  const result = validateSelection({ entryId, args }, ctx(text, extra));
  return result.ok ? result.value.args : `refused:${result.reason}`;
}

describe('a weekday symbol is spelled the way the owner named the week, when it is the same day', () => {
  it('"금요일" said on a Wednesday: this-fri and fri are the same Friday, so the canonical form is fri', () => {
    expect(argsOf('calendar.events', '금요일 일정 뭐야?', { range: 'this-fri' })).toEqual({ range: 'fri' });
    expect(argsOf('calendar.events', '금요일 일정 뭐야?', { range: 'fri' })).toEqual({ range: 'fri' });
    expect(argsOf('jira.issues', '금요일 마감인 이슈', { window: 'due', range: 'this-fri' })).toEqual({ window: 'due', range: 'fri' });
    // Today itself: wed and this-wed are both today.
    expect(argsOf('calendar.events', '수요일 일정', { range: 'this-wed' })).toEqual({ range: 'wed' });
  });

  it('another day is never rewritten: "금요일" read as next-fri on a Wednesday stays next-fri (a visible selector error)', () => {
    expect(argsOf('calendar.events', '금요일 일정 뭐야?', { range: 'next-fri' })).toEqual({ range: 'next-fri' });
    expect(argsOf('jira.issues', '금요일 마감인 이슈', { window: 'due', range: 'next-fri' })).toEqual({ window: 'due', range: 'next-fri' });
  });

  it('on a Saturday this-fri (yesterday) and fri (next Friday) differ, so the selector\'s choice stands; next-fri is fri', () => {
    expect(argsOf('calendar.events', '금요일 일정 뭐야?', { range: 'this-fri' }, { now: SATURDAY })).toEqual({ range: 'this-fri' });
    expect(argsOf('calendar.events', '금요일 일정 뭐야?', { range: 'next-fri' }, { now: SATURDAY })).toEqual({ range: 'fri' });
  });

  it('a Korean week anchor keeps its own form: "이번 주 금요일" = this-fri, "다음 주 수" = next-wed', () => {
    expect(argsOf('calendar.events', '이번 주 금요일 일정', { range: 'fri' })).toEqual({ range: 'this-fri' });
    expect(argsOf('calendar.events', '이번 주 금 일정 알려줘', { range: 'fri' })).toEqual({ range: 'this-fri' });
    expect(argsOf('calendar.events', '다음 주 수 일정 있어?', { range: 'next-wed' })).toEqual({ range: 'next-wed' });
    // On a Saturday, next-mon and mon are the same day, but the owner said 다음 주.
    expect(argsOf('calendar.events', '다음 주 월요일 일정', { range: 'mon' }, { now: SATURDAY })).toEqual({ range: 'next-mon' });
  });

  it('a follow-up that only names a day takes the week of the previous period ("목요일 거는?" after this week)', () => {
    expect(argsOf('calendar.events', '목요일 거는?', { range: 'thu' }, { previousArgs: { range: 'this-week' } })).toEqual({ range: 'this-thu' });
    expect(argsOf('calendar.events', '목요일 거는?', { range: 'this-thu' }, { previousArgs: { range: 'this-week' } })).toEqual({ range: 'this-thu' });
    // A previous period given as a span (a grammar's record) or as next week: the anchored day inside it.
    expect(argsOf('calendar.events', '목요일 거는?', { range: 'thu' }, { previousArgs: { range: '10-12..10-18' } })).toEqual({ range: 'this-thu' });
    expect(argsOf('calendar.events', '월요일은?', { range: 'mon' }, { now: SATURDAY, previousArgs: { range: 'next-week' } })).toEqual({ range: 'next-mon' });
    // A single previous day names no week.
    expect(argsOf('calendar.events', '목요일 거는?', { range: 'this-thu' }, { previousArgs: { range: 'today' } })).toEqual({ range: 'thu' });
    // Without a previous week the bare form is canonical.
    expect(argsOf('calendar.events', '목요일 거는?', { range: 'this-thu' })).toEqual({ range: 'thu' });
  });

  it('English anchors, the week after next, dates and other weekdays are left alone', () => {
    expect(argsOf('calendar.events', 'what do I have this Friday?', { range: 'fri' })).toEqual({ range: 'fri' });
    expect(argsOf('calendar.events', 'what do I have this Friday?', { range: 'this-fri' })).toEqual({ range: 'this-fri' });
    expect(argsOf('calendar.events', '금요일 일정 뭐야?', { range: '10-16' })).toEqual({ range: '10-16' });
    expect(argsOf('mail.list', '지난주 수에 온 메일', { range: 'last-wed' })).toEqual({ range: 'last-wed' });
    const afterNext = nlExpressedWeekday('다다음 주 수요일 일정');
    expect(nlCanonicalWeekdaySymbol('wed', afterNext, undefined, WEDNESDAY, TZ)).toBe('wed');
    expect(nlCanonicalWeekdaySymbol('this-thu', nlExpressedWeekday('금요일 일정'), undefined, WEDNESDAY, TZ)).toBe('this-thu');
    expect(nlCanonicalWeekdaySymbol('this-week', nlExpressedWeekday('금요일 일정'), undefined, WEDNESDAY, TZ)).toBe('this-week');
    expect(nlCanonicalWeekdaySymbol('this-fri', undefined, undefined, WEDNESDAY, TZ)).toBe('this-fri');
  });

  it('the weekday guard still runs on the canonical form', () => {
    expect(argsOf('calendar.events', '다음 주 수 일정 있어?', { range: 'wed' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '이번 주 금요일 일정', { range: 'next-fri' })).toBe('refused:weekday');
  });
});

describe('prompt nl-select.v20: the weekday lines of the range symbols carry three examples', () => {
  it('a bare weekday, a this-week weekday, and a one-syllable weekday after a week word', () => {
    const prompt = buildSelectionPrompt({ entries: ALL, text: '' });
    expect(prompt).toContain('mon..sun (the nearest such day: 금요일 = fri); this-mon..this-sun (that day of this week: 이번 주 금요일 = this-fri);\n');
    expect(prompt).toContain('(that day of next / last week: 지난주 금요일 = last-fri, 다음 주 수 = next-wed);\n');
  });
});
