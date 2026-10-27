import { describe, expect, it } from 'vitest';
import { nlStatedLabelPeriod } from './action-entries';
import { nlInheritHeldRange } from './nl-selection-service';
import { nlOwnerStatedRange } from './owner-period';
import { validateSelection, type NlValidatedSelection, type NlValidationContext } from './selection-validator';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// Owner decision of 2026-10-27 (range grounding): the one label-table period the owner states wins over another range.
const NOW = '2026-10-27T03:00:00.000Z';
const offered = new Map(Object.values(NL_WAVE1_ENTRIES).map((entry) => [entry.id, entry] as const));
const ctxOf = (text: string, previousArgs?: Record<string, string>): NlValidationContext => ({ offered, groundingText: text, now: NOW, timeZone: 'Asia/Seoul', ...(previousArgs ? { previousArgs, previousEntryId: 'calendar.events' } : {}) });
const selected = (text: string, args: Record<string, unknown>, previousArgs?: Record<string, string>, entryId = 'calendar.events'): NlValidatedSelection => {
  const result = validateSelection({ entryId, args }, ctxOf(text, previousArgs));
  if (!result.ok) throw new Error(`${text}: ${result.reason}`);
  return result.value;
};
const final = (text: string, args: Record<string, unknown>, previousArgs?: Record<string, string>) => nlOwnerStatedRange(selected(text, args, previousArgs), text, ctxOf(text, previousArgs)).args;

describe('nlStatedLabelPeriod (the existing period-label table only)', () => {
  it('reads one label period, and leaves weekdays, spans, two periods and leftover time units alone', () => {
    expect(nlStatedLabelPeriod('다다음 주 일정 알려줘')).toBe('week-after-next');
    expect(nlStatedLabelPeriod('이번 달 말까지 일정 보여줘')).toBe('rest-of-month');
    expect(nlStatedLabelPeriod('다음 주말에 잡힌 일정 있어?')).toBe('next-weekend');
    expect(nlStatedLabelPeriod("what's on the week after next?")).toBe('week-after-next');
    expect(nlStatedLabelPeriod('앞으로 7일 일정')).toBe('next-7-days');
    for (const text of ['목요일 거는?', '다음 주 수요일까지 일정 보여줘', '10월 1일부터 7일까지 일정 보여줘', '내일이랑 모레 일정', '내일 3시 회의 있어?', '앞으로 10일 일정', '그 세미나 어디서 해?']) {
      expect(nlStatedLabelPeriod(text), text).toBeUndefined();
    }
  });
});

describe('nlOwnerStatedRange', () => {
  it('week-after-next, rest-of-month and next-weekend win over the selector\'s other range (or its omitted one)', () => {
    expect(final('다다음 주 일정 알려줘', { range: 'next-week' })).toEqual({ range: 'week-after-next' });
    expect(final('이번 달 말까지 일정 보여줘', { range: 'this-month' })).toEqual({ range: 'rest-of-month' });
    expect(final('다음 주말에 잡힌 일정 있어?', { range: 'this-weekend' })).toEqual({ range: 'next-weekend' });
    expect(final('다음 주말에 잡힌 일정 있어?', {})).toEqual({ range: 'next-weekend' });
    expect(final('다다음 주는?', { range: 'next-week' }, { range: 'next-week' })).toEqual({ range: 'week-after-next' });
    // "아니" is one of the shared negation markers: fail-safe, the selector's range stays (uat5r4-17 is a selector matter).
    expect(final('아니 다다음 주', { range: 'next-week' }, { range: 'next-week' })).toEqual({ range: 'next-week' });
  });

  it('keeps the selector\'s range for a weekday ("목요일 거는?"), a span, "today", the same dates and an unstated period', () => {
    expect(final('목요일 거는?', { range: 'this-thu' }, { range: 'this-week' })).toEqual({ range: 'this-thu' });
    expect(final('다음 주 수요일까지 일정 보여줘', { range: 'until-next-wed' })).toEqual({ range: 'until-next-wed' });
    expect(final('오늘 일정 알려줘', { range: 'tomorrow' })).toEqual({ range: 'tomorrow' });
    expect(final('다음 주말에 잡힌 일정 있어?', { range: 'next-weekend' })).toEqual({ range: 'next-weekend' });
    expect(final('그 세미나 어디서 해?', { range: 'next-week', keyword: '세미나' }, { range: 'next-week' })).toEqual({ range: 'next-week', keyword: '세미나' });
  });

  it('Codex review of 86271dd5: an excluded period is never stated, a period inside a value is the value\'s, and only an item-date range is grounded', () => {
    // 1. Exclusion / negation: the clause-grounded rule's own markers, no new word.
    expect(final('내일 말고 일정 보여줘', { range: 'this-week' })).toEqual({ range: 'this-week' });
    expect(final('다음 주 일정은 빼고 보여줘', { range: 'this-month' })).toEqual({ range: 'this-month' });
    // 2. The read's own values are set aside first: the keyword "다음 주 계획" is an event title.
    expect(final('다음 주 계획 회의 찾아줘', { range: 'this-month', keyword: '다음 주 계획' })).toEqual({ range: 'this-month', keyword: '다음 주 계획' });
    expect(final('"다음 주 계획" 회의 찾아줘', { range: 'this-month', keyword: '다음 주 계획' })).toEqual({ range: 'this-month', keyword: '다음 주 계획' });
    // Codex delta review of 6cc157e6: periods are counted over the whole message (coordinated periods are two).
    expect(final('내일이랑 모레 일정 보여줘', { range: 'this-week' })).toEqual({ range: 'this-week' });
    // One part negated: "내일 말고" is its own (excluded) clause and is set aside, so the one period left, 모레, is stated.
    // When the negation sits in the read's own clause ("내일 일정 말고 모레 거"), the selector's range stays (fail-safe).
    expect(final('내일 말고 모레 일정 보여줘', { range: 'this-week' })).toEqual({ range: 'day-after-tomorrow' });
    expect(final('내일 일정 말고 모레 거 보여줘', { range: 'this-week' })).toEqual({ range: 'this-week' });
    // A second, unrelated read in another clause: its period counts too (two periods: left alone); a negated other clause
    // ("안 읽은 메일") is set aside, so the calendar's one period still counts.
    expect(final('다다음 주 일정 보여주고 어제 메일도 알려줘', { range: 'next-week' })).toEqual({ range: 'next-week' });
    expect(final('다다음 주 일정이랑 안 읽은 메일 보여줘', { range: 'next-week' })).toEqual({ range: 'week-after-next' });
    // Codex delta review of 02fd5380: a period only another read's clause states is that read's ("어제" is the mail's).
    expect(final('일정 보여주고 어제 메일도 알려줘', { range: 'this-week' })).toEqual({ range: 'this-week' });
    expect(final('일정 보여주고 다다음 주 메일도 알려줘', { range: 'this-week' })).toEqual({ range: 'this-week' });
    // 3. Only calendar.events (`rangeIsItemDate`): a mail range is receipt time, so the selector decides.
    const mailText = '어제 회의 관련 메일 보여줘';
    const mail = selected(mailText, {}, undefined, 'mail.list');
    expect(nlOwnerStatedRange(mail, mailText, ctxOf(mailText))).toBe(mail);
    const items = Object.values(NL_WAVE1_ENTRIES).filter((entry) => entry.rangeIsItemDate === true).map((entry) => entry.id);
    expect(items).toEqual(['calendar.events']);
  });

  it('explicit periods still win over the held listing\'s (P-time (ii) never inherits when the owner states one)', () => {
    const text = '다다음 주는?';
    const held = { entryId: 'calendar.events', args: { range: 'next-week' } };
    const inherited = nlInheritHeldRange(selected(text, {}, held.args), held, text, ctxOf(text, held.args));
    expect(inherited.args.range).toBeUndefined();
    expect(nlOwnerStatedRange(inherited, text, ctxOf(text, held.args)).args).toEqual({ range: 'week-after-next' });
    // No stated period: the held one is inherited and nothing replaces it.
    const plain = '그 면접 어디서 해?';
    const kept = nlInheritHeldRange(selected(plain, { keyword: '면접' }, held.args), held, plain, ctxOf(plain, held.args));
    expect(nlOwnerStatedRange(kept, plain, ctxOf(plain, held.args)).args).toEqual({ range: 'next-week', keyword: '면접' });
  });
});
