import { describe, expect, it } from 'vitest';
import type { NlArgs, NlCatalogEntry } from './catalog';
import { buildSelectionPrompt } from './selection-prompt';
import { validateSelection, type NlValidationContext } from './selection-validator';
import { nlIsPastStatement } from './statement-guard';
import { isNlRangeSymbol, nlExpressedWeekday, nlRangeLabel, normalizeNlRangeSymbol, resolveNlRange } from './symbolic-time';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 amendment A7 (Proposed, 2026-10-15): the open-start `until-<weekday>` / `until-next-<weekday>` periods, their
// grounding by the owner's inclusive end bound, the single day at such a bound spelled as `until-*`, and the clear
// past-tense statement check. Paraphrased phrases; no real names.

const TZ = 'Asia/Seoul';
const THURSDAY = '2026-10-15T00:30:00.000Z'; // Thursday 2026-10-15 09:30 in Asia/Seoul
const FRIDAY = '2026-10-16T00:30:00.000Z';
const SATURDAY = '2026-10-17T03:00:00.000Z';
const SUNDAY = '2026-10-18T03:00:00.000Z';
const ALL: readonly NlCatalogEntry[] = Object.values(NL_WAVE1_ENTRIES);

function ctx(groundingText: string, extra: Partial<NlValidationContext> = {}): NlValidationContext {
  return { offered: new Map(ALL.map((entry) => [entry.id, entry] as const)), groundingText, now: THURSDAY, timeZone: TZ, ...extra };
}
function argsOf(entryId: 'calendar.events' | 'jira.issues' | 'mail.list', text: string, args: NlArgs, extra: Partial<NlValidationContext> = {}): NlArgs | string {
  const result = validateSelection({ entryId, args }, ctx(text, extra));
  return result.ok ? result.value.args : `refused:${result.reason}`;
}
function span(symbol: string, now: string): string | undefined {
  const range = resolveNlRange(symbol, now, TZ);
  return range === undefined ? undefined : `${range.startDate.month}/${range.startDate.day}+${range.days}`;
}

describe('A7 symbols: until-<weekday> is today through the nearest such day, until-next-<weekday> through that day of next week', () => {
  it('resolves in Asia/Seoul with Monday-based weeks', () => {
    expect(span('until-fri', THURSDAY)).toBe('10/15+2');
    expect(span('until-thu', THURSDAY)).toBe('10/15+1');
    expect(span('until-wed', THURSDAY)).toBe('10/15+7');
    expect(span('until-fri', FRIDAY)).toBe('10/16+1');
    // On a Saturday the nearest Friday is next week's, exactly like the bare `fri`.
    expect(span('until-fri', SATURDAY)).toBe('10/17+7');
    expect(span('until-next-wed', THURSDAY)).toBe('10/15+7');
    expect(span('until-next-fri', THURSDAY)).toBe('10/15+9');
    expect(span('until-next-sun', THURSDAY)).toBe('10/15+11');
    expect(span('until-next-mon', SUNDAY)).toBe('10/18+2');
  });

  it('is a closed spelling: full English names normalise, anything else is not a symbol', () => {
    expect(normalizeNlRangeSymbol('until-Friday')).toBe('until-fri');
    expect(normalizeNlRangeSymbol('until-next-wednesday')).toBe('until-next-wed');
    for (const symbol of ['until-fri', 'until-next-sun']) expect(isNlRangeSymbol(symbol)).toBe(true);
    for (const symbol of ['until-this-fri', 'until-last-fri', 'until-friday-week', 'from-fri', 'until-10-16']) expect(isNlRangeSymbol(symbol)).toBe(false);
  });

  it('is shown to the owner as its own date span', () => {
    expect(nlRangeLabel(resolveNlRange('until-fri', THURSDAY, TZ)!, 'ko')).toBe('10월 15일~10월 16일');
    expect(nlRangeLabel(resolveNlRange('until-next-wed', THURSDAY, TZ)!, 'en')).toBe('2026-10-15~2026-10-21');
  });

  it('the inclusive end bound is the closed A5 bound set: 까지 (spaced, 날) and by / until / till / through; not 부터, from, ~ or 전까지', () => {
    for (const text of ['금요일까지 일정', '금요일 까지 일정', '금요일날까지 일정', '이번 주 금까지 일정', 'my calendar through Friday', 'events until Friday', 'by this Friday']) {
      expect(nlExpressedWeekday(text)?.until, text).toBe(true);
    }
    for (const text of ['금요일부터 일정', '금요일 전까지 일정', '금요일 일정', 'from Friday', 'after Friday', '금요일~']) {
      expect(nlExpressedWeekday(text)?.until, text).toBeUndefined();
    }
  });
});

describe('A7 grounding: an until-* period needs the owner\'s inclusive end bound on that weekday and ends on the day they named', () => {
  it('the live sentence: "이번 주 금요일까지 일정" validates as until-fri on a Thursday', () => {
    expect(argsOf('calendar.events', '이번 주 금요일까지 일정', { range: 'until-fri' })).toEqual({ range: 'until-fri' });
    expect(argsOf('calendar.events', '금요일까지 일정', { range: 'until-fri' })).toEqual({ range: 'until-fri' });
    expect(argsOf('calendar.events', 'what is on my calendar through Friday?', { range: 'until-fri' })).toEqual({ range: 'until-fri' });
    expect(argsOf('calendar.events', '다음 주 수요일까지 일정 보여줘', { range: 'until-next-wed' })).toEqual({ range: 'until-next-wed' });
    expect(argsOf('jira.issues', '다음 주 화요일까지 마감인 지라 이슈', { window: 'due', range: 'until-next-tue' })).toEqual({ window: 'due', range: 'until-next-tue' });
  });

  it('is refused (asked) without the bound, with another bound word, another weekday or another week', () => {
    expect(argsOf('calendar.events', '금요일 일정', { range: 'until-fri' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '금요일부터 일정', { range: 'until-fri' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '금요일 전까지 일정', { range: 'until-fri' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '목요일까지 일정', { range: 'until-fri' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '이번 주 일정', { range: 'until-fri' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '이번 주 금요일까지 일정', { range: 'until-next-fri' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '다음 주 금요일까지 일정', { range: 'until-fri' })).toBe('refused:weekday');
    // Two weekdays ("월요일부터 금요일까지") are no open-start period.
    expect(argsOf('calendar.events', '월요일부터 금요일까지 일정', { range: 'until-fri' })).toBe('refused:weekday');
  });

  it('"이번 주 금요일까지" said on a Saturday is asked, never rolled into next week', () => {
    expect(argsOf('calendar.events', '이번 주 금요일까지 일정', { range: 'until-fri' }, { now: SATURDAY })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '이번 주 금요일까지 일정', { range: 'this-fri' }, { now: SATURDAY })).toBe('refused:weekday');
    // Without a week word the nearest Friday is meant, as for the bare `fri`.
    expect(argsOf('calendar.events', '금요일까지 일정', { range: 'until-fri' }, { now: SATURDAY })).toEqual({ range: 'until-fri' });
  });

  it('a follow-up that names no weekday may carry the previous identical symbol; a fresh message may not', () => {
    expect(argsOf('calendar.events', '오후만', { range: 'until-fri', partOfDay: 'afternoon' }, { previousArgs: { range: 'until-fri' } })).toEqual({ range: 'until-fri', partOfDay: 'afternoon' });
    expect(argsOf('calendar.events', '오후만', { range: 'until-fri', partOfDay: 'afternoon' })).toBe('refused:weekday');
  });
});

describe('A7 canonical form: a single day at an inclusive end bound is the until-* symbol that ends on the same day', () => {
  it('"이번 주 금요일까지 일정" read as this-fri, fri or the date 10-16 is today through Friday', () => {
    for (const range of ['this-fri', 'fri', '10-16']) expect(argsOf('calendar.events', '이번 주 금요일까지 일정', { range }), range).toEqual({ range: 'until-fri' });
    expect(argsOf('calendar.events', '다음 주 수요일까지 일정 보여줘', { range: 'next-wed' })).toEqual({ range: 'until-next-wed' });
    expect(argsOf('jira.issues', '금요일까지 마감인 지라 이슈', { window: 'due', range: 'fri' })).toEqual({ window: 'due', range: 'until-fri' });
    expect(argsOf('calendar.events', 'anything through Friday?', { range: 'fri' })).toEqual({ range: 'until-fri' });
    // Today itself: "목요일까지" on a Thursday is the one day, spelled until-thu.
    expect(argsOf('calendar.events', '목요일까지 일정', { range: 'today' })).toEqual({ range: 'until-thu' });
  });

  it('a single day that is not the day the owner bounds is refused, never widened (eval 2026-10-15: next-sun for "일요일까지")', () => {
    expect(argsOf('calendar.events', '일요일까지 일정 뭐 있어?', { range: 'next-sun' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', "what's on my calendar through Friday?", { range: 'next-fri' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '일요일까지 일정 뭐 있어?', { range: 'sun' })).toEqual({ range: 'until-sun' });
  });

  it('a multi-day period that contains the day stays as the selector chose it (nothing hidden)', () => {
    expect(argsOf('calendar.events', '이번 주 금요일까지 일정', { range: 'this-week' })).toEqual({ range: 'this-week' });
    expect(argsOf('calendar.events', '금요일까지 일정', { range: 'next-7-days' })).toEqual({ range: 'next-7-days' });
  });

  it('a past bounded day has no until-* symbol and is asked; another day is still refused by the A5 rule', () => {
    expect(argsOf('calendar.events', '지난주 금요일까지 일정', { range: 'last-fri' })).toBe('refused:weekday');
    expect(argsOf('calendar.events', '금요일까지 일정', { range: 'sat' })).toBe('refused:weekday');
  });

  it('without an end bound a single day is untouched (fri stays fri; 부터 is a start)', () => {
    expect(argsOf('calendar.events', '금요일 일정', { range: 'fri' })).toEqual({ range: 'fri' });
    expect(argsOf('calendar.events', '금요일부터 일정', { range: 'fri' })).toEqual({ range: 'fri' });
  });

  it('an uncertain weekday ("다음 주 일까지") is left to the A5 rule', () => {
    expect(argsOf('calendar.events', '다음 주 일까지 많아?', { range: 'next-sun' })).toEqual({ range: 'next-sun' });
  });
});

describe('A7 statement check: a clear past-tense statement is not a request to read', () => {
  it.each([
    '어제 일정 있었는데 까먹었어 ㅠ',
    '지난주 회의 진짜 길었어',
    '어제 메일 너무 많이 왔더라',
    '아까 슬랙 봤는데 별거 없더라',
    '오늘 일정 꽉 찼었어',
    '회의 끝났다',
    '드라이브 정리 다 했어',
    '일정 추가했어',
    '회의 끝났습니다',
    '메일 다 읽었다ㅋㅋ',
  ])('%j is a statement', (text) => {
    expect(nlIsPastStatement(text)).toBe(true);
  });

  it.each([
    '어제 일정 뭐 있었지?',
    '어제 온 메일',
    '내일 일정',
    '지난주 메일 뭐 왔었어',
    '어제 무슨 메일 왔더라?',
    // A casual question without its question mark: the existence verb and a bare arrival stay requests.
    '어제 일정 있었어',
    '메일 왔어',
    '새메일 왔나',
    '어제 회의 길었어',
    '오늘 뭐 해야 되더라',
    '알림 뭐 걸어놨더라',
    '어제 일정 있었는데 알려줘',
    '어제 회의 길었어. 오늘 일정 보여줘',
    'I forgot my meeting yesterday',
  ])('%j is not', (text) => {
    expect(nlIsPastStatement(text)).toBe(false);
  });

  it('refuses a READ entry as `statement`, before any arg check; a request in the same words still validates', () => {
    expect(argsOf('calendar.events', '어제 일정 있었는데 까먹었어 ㅠ', { range: 'yesterday' })).toBe('refused:statement');
    expect(argsOf('mail.list', '어제 메일 너무 많이 왔더라', { range: 'yesterday' })).toBe('refused:statement');
    expect(argsOf('calendar.events', '어제 일정 뭐 있었지?', { range: 'yesterday' })).toEqual({ range: 'yesterday' });
    expect(argsOf('calendar.events', '어제 일정 있었어', { range: 'yesterday' })).toEqual({ range: 'yesterday' });
  });
});

describe('prompt nl-select.v22: one until-* line with one example after the date line, and the past-remark rule', () => {
  it('shows the symbols, the example and the rule-2 lines; the Jira due example is unchanged', () => {
    const prompt = buildSelectionPrompt({ entries: ALL, text: '' });
    expect(prompt).toContain(
      'MM-DD..MM-DD for a span of at most 31 days.\nuntil-mon..until-sun (from today through the nearest such day: 금요일까지 = until-fri); until-next-mon..until-next-sun (from today through that day of next week);\n',
    );
    expect(prompt).toContain('Message: 이번 주 금요일까지인 이슈들 알려줄래\nOutput: {"entryId":"jira.issues","args":{"window":"due","range":"this-week"}');
    expect(prompt).toContain('   A remark about what already happened or how it went ("…했어", "…끝났다", "…더라", "…었는데 …") is none even when it\n');
    expect(prompt.match(/until-fri/g)).toHaveLength(1);
  });
});

describe('A7 spelling: the same span is written the way the owner named the week', () => {
  it('"다음 주 수요일까지" on a Thursday is until-next-wed even though until-wed covers the same days', () => {
    expect(argsOf('calendar.events', '다음 주 수요일까지 일정 보여줘', { range: 'until-wed' })).toEqual({ range: 'until-next-wed' });
    expect(argsOf('calendar.events', '수요일까지 일정 보여줘', { range: 'until-next-wed' })).toEqual({ range: 'until-wed' });
    // Different spans are never rewritten: "수요일까지" on a Monday is this Wednesday, so until-next-wed is refused.
    expect(argsOf('calendar.events', '수요일까지 일정', { range: 'until-next-wed' }, { now: '2026-10-12T03:00:00.000Z' })).toBe('refused:weekday');
  });
});
