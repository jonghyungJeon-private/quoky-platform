import { describe, expect, it } from 'vitest';
import type { NlCatalogEntry } from './catalog';
import { buildSelectionPrompt, NL_SELECTION_PROMPT_VERSION } from './selection-prompt';
import { lastSelectionRecord, migrateStoredSelection, readLastSelection } from './selection-state';
import { validateSelection, type NlValidationContext } from './selection-validator';
import { isNlRangeSymbol, isTimeExpression, nlRangeLabel, normalizeNlRangeSymbol, resolveNlRange } from './symbolic-time';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// Live edge-case UAT (2026-10-14), read-side gaps R1-R8: symbolic time, time words never keywords, grounded flags and
// enums, mail range migration, stored selections. Paraphrased phrases; no real names or issue keys.

const TZ = 'Asia/Seoul';
const NOW = '2026-10-12T03:00:00.000Z'; // Monday 2026-10-12 12:00 in Asia/Seoul
const ALL: readonly NlCatalogEntry[] = Object.values(NL_WAVE1_ENTRIES);

function ctx(groundingText: string, extra: Partial<NlValidationContext> = {}): NlValidationContext {
  return { offered: new Map(ALL.map((entry) => [entry.id, entry] as const)), groundingText, now: NOW, timeZone: TZ, ...extra };
}

describe('R3 symbolic time: last-<weekday>, this-<weekday>, week-after-next, rest-of-month', () => {
  it.each([
    ['last-fri', '2026-10-08T15:00:00.000Z', '2026-10-09T15:00:00.000Z'],
    ['last-mon', '2026-10-04T15:00:00.000Z', '2026-10-05T15:00:00.000Z'],
    ['last-sun', '2026-10-10T15:00:00.000Z', '2026-10-11T15:00:00.000Z'],
    ['this-thu', '2026-10-14T15:00:00.000Z', '2026-10-15T15:00:00.000Z'],
    ['this-mon', '2026-10-11T15:00:00.000Z', '2026-10-12T15:00:00.000Z'],
    ['next-wed', '2026-10-20T15:00:00.000Z', '2026-10-21T15:00:00.000Z'],
    ['week-after-next', '2026-10-25T15:00:00.000Z', '2026-11-01T15:00:00.000Z'],
    ['rest-of-month', '2026-10-11T15:00:00.000Z', '2026-10-31T15:00:00.000Z'],
  ])('%s -> [%s, %s)', (symbol, from, to) => {
    expect(isNlRangeSymbol(symbol)).toBe(true);
    expect(resolveNlRange(symbol, NOW, TZ)).toMatchObject({ from, to });
  });

  it('normalizes full English weekday names with the new prefixes and labels the new periods', () => {
    expect(normalizeNlRangeSymbol('Last-Friday')).toBe('last-fri');
    expect(normalizeNlRangeSymbol('this-thursday')).toBe('this-thu');
    expect(nlRangeLabel(resolveNlRange('week-after-next', NOW, TZ)!, 'ko')).toBe('다다음 주');
    expect(nlRangeLabel(resolveNlRange('rest-of-month', NOW, TZ)!, 'ko')).toBe('이번 달 말까지');
    expect(nlRangeLabel(resolveNlRange('last-fri', NOW, TZ)!, 'ko')).toBe('10월 9일');
  });

  it('rest-of-month is one day on the last day of the month and never exceeds 31 days', () => {
    expect(resolveNlRange('rest-of-month', '2026-10-31T03:00:00.000Z', TZ)).toMatchObject({ days: 1 });
    expect(resolveNlRange('rest-of-month', '2026-10-01T03:00:00.000Z', TZ)).toMatchObject({ days: 31 });
  });

  it('shows the selector the new symbols', () => {
    const prompt = buildSelectionPrompt({ entries: ALL, text: '' });
    expect(NL_SELECTION_PROMPT_VERSION).toBe('nl-select.v27');
    expect(prompt).toContain('week-after-next');
    expect(prompt).toContain('rest-of-month');
    expect(prompt).toContain('last-mon..last-sun');
    expect(prompt).toContain('this-mon..this-sun');
  });
});

describe('R4 a weekday, date or time word is a period, never a title keyword', () => {
  it.each(['목요일', '내일 오후', '다다음 주', '10월 20일', '다음 주 수요일', 'thursday', 'next week', '3시', '이번 달 말'])('%s is a time expression', (text) => {
    expect(isTimeExpression(text)).toBe(true);
  });

  it.each(['스크럼', '목요일 회의', '위클리 스탠드업', '정산', '', 'friday release'])('%j is not', (text) => {
    expect(isTimeExpression(text)).toBe(false);
  });

  it('the validator rejects such a keyword on an entry with a period, naming the arg, and a real keyword stays valid', () => {
    expect(validateSelection({ entryId: 'calendar.events', args: { range: 'this-week', keyword: '목요일' } }, ctx('목요일 거는?'))).toEqual({
      ok: false,
      reason: 'time-keyword',
      entryId: 'calendar.events',
      arg: 'keyword',
    });
    expect(validateSelection({ entryId: 'jira.issues', args: { keyword: '다음 주' } }, ctx('다음 주 이슈'))).toMatchObject({ ok: false, reason: 'time-keyword' });
    expect(validateSelection({ entryId: 'calendar.events', args: { keyword: '스크럼' } }, ctx('스크럼만'))).toMatchObject({ ok: true });
  });

  it('a keyword carried from the previous selection is rejected the same way (no sticking across periods)', () => {
    const result = validateSelection({ entryId: 'calendar.events', args: { range: 'next-week', keyword: '목요일' } }, ctx('다음 주는?', { previousArgs: { range: 'this-week', keyword: '목요일' } }));
    expect(result).toMatchObject({ ok: false, reason: 'time-keyword' });
  });

  it('a stored selection that carries a time-word keyword loses it, a real keyword is kept', () => {
    expect(migrateStoredSelection({ entryId: 'calendar.events', args: { range: 'this-week', keyword: '목요일' } })).toEqual({ entryId: 'calendar.events', args: { range: 'this-week' } });
    expect(migrateStoredSelection({ entryId: 'calendar.events', args: { range: 'this-week', keyword: '스크럼' } })).toEqual({ entryId: 'calendar.events', args: { range: 'this-week', keyword: '스크럼' } });
    const session = { metadata: { 'quoky.lastSelection': lastSelectionRecord('a-1', { entryId: 'calendar.events', args: { keyword: '내일' } }, NOW) } };
    expect(readLastSelection(session, 'a-1', NOW)).toMatchObject({ entryId: 'calendar.events', args: {} });
  });
});

describe('R1 mail range: today migrates cleanly', () => {
  it('validates a symbolic period and resolves it in the owner zone', () => {
    const result = validateSelection({ entryId: 'mail.list', args: { range: 'yesterday' } }, ctx('어제 온 메일'));
    expect(result).toMatchObject({ ok: true, value: { args: { range: 'yesterday' }, range: { from: '2026-10-10T15:00:00.000Z', to: '2026-10-11T15:00:00.000Z' } } });
    expect(validateSelection({ entryId: 'mail.list', args: { range: 'last-week' } }, ctx('지난주 메일'))).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'mail.list', args: { range: 'upcoming' } }, ctx('메일'))).toMatchObject({ ok: false, reason: 'range' });
  });

  it('the old `today` flag becomes range today, and range wins when both are given', () => {
    expect(validateSelection({ entryId: 'mail.list', args: { today: true } }, ctx('오늘 온 메일'))).toMatchObject({ ok: true, value: { args: { range: 'today' } } });
    expect(validateSelection({ entryId: 'mail.list', args: { today: true, range: 'yesterday' } }, ctx('어제'))).toMatchObject({ ok: true, value: { args: { range: 'yesterday' } } });
    expect(validateSelection({ entryId: 'mail.list', args: { today: false } }, ctx('메일'))).toMatchObject({ ok: true, value: { args: {} } });
  });

  it('a stored selection with `today` is read as range today', () => {
    expect(migrateStoredSelection({ entryId: 'mail.list', args: { unread: true, today: true } })).toEqual({ entryId: 'mail.list', args: { unread: true, range: 'today' } });
    const session = { metadata: { 'quoky.lastSelection': lastSelectionRecord('a-1', { entryId: 'mail.list', args: { today: true } }, NOW) } };
    expect(readLastSelection(session, 'a-1', NOW)).toMatchObject({ args: { range: 'today' } });
  });

  it('shows the period in the basis line and hides the deprecated flag from the selector', () => {
    const mail = NL_WAVE1_ENTRIES['mail.list'];
    const yesterday = resolveNlRange('yesterday', NOW, TZ);
    expect(mail.describe?.({ range: 'yesterday' }, yesterday, 'ko')).toBe('어제 받은 메일');
    expect(mail.describe?.({ range: 'yesterday', unread: true }, yesterday, 'en')).toBe('received yesterday, unread mail');
    expect(mail.describe?.({}, undefined, 'ko')).toBe('최근 메일');
    const prompt = buildSelectionPrompt({ entries: [mail], text: '어제 온 메일' });
    expect(prompt).toContain('range: range symbol');
    expect(prompt).not.toContain('today: true');
    expect(prompt).not.toContain('Deprecated');
  });
});

describe('R2/R5 calendar part of day and timed-only are grounded in the owner words', () => {
  const calendar = (args: Record<string, string | boolean>, text: string, previousArgs?: Record<string, string | boolean>) =>
    validateSelection({ entryId: 'calendar.events', args }, ctx(text, previousArgs !== undefined ? { previousArgs } : {}));

  it.each([
    ['afternoon', '내일 오후에 시간 비어?'],
    ['afternoon', '점심 이후로 뭐 있어'],
    ['morning', '내일 오전 일정'],
    ['morning', '아침에 뭐 있어'],
    ['evening', '저녁에 약속 있나'],
    ['evening', '오늘 밤 일정'],
    ['afternoon', 'anything this afternoon'],
  ])('%s is accepted for %j', (partOfDay, text) => {
    expect(calendar({ range: 'tomorrow', partOfDay }, text)).toMatchObject({ ok: true, value: { args: { partOfDay } } });
  });

  it('a part of day the owner did not say is ungrounded unless it carries over from the previous selection', () => {
    expect(calendar({ partOfDay: 'afternoon' }, '내일 일정 알려줘')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'partOfDay' });
    expect(calendar({ partOfDay: 'afternoon' }, '다음 주는?', { partOfDay: 'afternoon' })).toMatchObject({ ok: true });
    expect(calendar({ partOfDay: 'noon' }, '정오')).toMatchObject({ ok: false, reason: 'invalid-arg' });
  });

  it('timedOnly needs a meeting word or the previous flag; it is not guessed', () => {
    expect(calendar({ range: 'this-week', timedOnly: true }, '그 중에 회의만')).toMatchObject({ ok: true, value: { args: { range: 'this-week', timedOnly: true } } });
    expect(calendar({ range: 'this-week', timedOnly: true }, 'only meetings please')).toMatchObject({ ok: true });
    expect(calendar({ range: 'this-week', timedOnly: true }, '이번 주 일정')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'timedOnly' });
    expect(calendar({ range: 'next-week', timedOnly: true }, '다음 주는?', { timedOnly: true })).toMatchObject({ ok: true });
    expect(calendar({ range: 'this-week', timedOnly: false }, '이번 주 일정')).toMatchObject({ ok: true, value: { args: { range: 'this-week' } } });
  });

  it('T1 (owner, 2026-10-15; prompt nl-select.v24): a meeting word means timed events in the arg description and the meeting examples', () => {
    const prompt = buildSelectionPrompt({ entries: ALL, text: '' });
    expect(NL_SELECTION_PROMPT_VERSION).toBe('nl-select.v27');
    expect(prompt).toContain('timedOnly: true. true when the owner asks about meetings/timed events and away from all-day entries such as leave or holidays ("회의만", "미팅만", "only meetings").');
    expect(prompt).not.toContain('true only when the owner narrows');
    expect(prompt).toContain('Output: {"entryId":"calendar.events","args":{"range":"tomorrow","timedOnly":true}');
    expect(prompt).toContain('Output: {"entryId":"calendar.events","args":{"range":"upcoming","timedOnly":true}');
    // The grounding is unchanged: a plain schedule question cannot carry the flag.
    expect(calendar({ range: 'tomorrow', timedOnly: true }, '내일 회의 있어?')).toMatchObject({ ok: true });
    expect(calendar({ range: 'this-week', timedOnly: true }, '이번 주 일정 다 보여줘')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'timedOnly' });
  });

  it('the basis line names the part of day and the timed-only narrowing', () => {
    const calendarEntry = NL_WAVE1_ENTRIES['calendar.events'];
    const tomorrow = resolveNlRange('tomorrow', NOW, TZ);
    expect(calendarEntry.describe?.({ range: 'tomorrow', partOfDay: 'afternoon' }, tomorrow, 'ko')).toBe('내일 오후 일정');
    expect(calendarEntry.describe?.({ range: 'tomorrow', partOfDay: 'afternoon' }, tomorrow, 'en')).toBe('tomorrow afternoon events');
    expect(calendarEntry.describe?.({ range: 'this-week', timedOnly: true }, resolveNlRange('this-week', NOW, TZ), 'ko')).toBe('이번 주 일정 / 시간 지정 일정만');
  });
});

describe('R7 a search keyword is the core term, grounded in the owner text', () => {
  it.each([
    ['슬랙에서 배포 얘기 나온 거 찾아줘', '배포 얘기 나온 거', '배포'],
    ['슬랙에서 배포 이야기 나온 거', '배포 이야기 나온 거', '배포'],
    ['슬랙에서 배포 관련 내용', '배포 관련 내용', '배포'],
    ['슬랙에서 장애 대응 얘기 나온 거 있나', '장애 대응 얘기 나온 거', '장애 대응'],
  ])('%j -> %j -> %j', (text, raw, core) => {
    expect(validateSelection({ entryId: 'slack.search', args: { keyword: raw } }, ctx(text))).toMatchObject({ ok: true, value: { args: { keyword: core } } });
  });

  it('never strips the only word and the result stays a substring of the owner text', () => {
    expect(validateSelection({ entryId: 'slack.search', args: { keyword: '얘기' } }, ctx('슬랙에서 얘기 찾아줘'))).toMatchObject({ value: { args: { keyword: '얘기' } } });
    const result = validateSelection({ entryId: 'slack.search', args: { keyword: '배포 얘기 나온 거' } }, ctx('슬랙에서 배포 얘기 나온 거 찾아줘'));
    expect(result.ok && String(result.value.args.keyword)).toBe('배포');
  });

  it('a search keyword may still be a time word (no range on the entry): "월요일" is a legitimate search term', () => {
    expect(validateSelection({ entryId: 'slack.search', args: { keyword: '월요일' } }, ctx('슬랙에서 월요일 검색'))).toMatchObject({ ok: true });
  });
});

describe('R8 jira sort is a closed enum grounded in the owner words', () => {
  const jira = (args: Record<string, string>, text: string, previousArgs?: Record<string, string>) =>
    validateSelection({ entryId: 'jira.issues', args }, ctx(text, previousArgs !== undefined ? { previousArgs } : {}));

  it.each([
    ['oldest', '제일 오래된 건 뭐야'],
    ['oldest', 'which one is the oldest'],
    ['newest', '가장 새로 만든 것 보여줘'],
    ['recently-updated', '최근에 업데이트된 순으로'],
    ['recently-updated', 'most recently updated first'],
  ])('%s for %j', (sort, text) => {
    expect(jira({ sort }, text)).toMatchObject({ ok: true, value: { args: { sort } } });
  });

  it('rejects a sort outside the set, an ungrounded sort and carries a previous one', () => {
    expect(jira({ sort: 'created ASC' }, '오래된 순')).toMatchObject({ ok: false, reason: 'invalid-arg', arg: 'sort' });
    expect(jira({ sort: 'oldest' }, '이슈 보여줘')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'sort' });
    expect(jira({ sort: 'oldest' }, '다시 보여줘', { sort: 'oldest' })).toMatchObject({ ok: true });
  });

  it('the basis line says the order', () => {
    expect(NL_WAVE1_ENTRIES['jira.issues'].describe?.({ sort: 'oldest' }, undefined, 'ko')).toBe('내가 담당 / 미해결 / 오래된 순');
  });
});

describe('R6 mail item picks', () => {
  it('item is a bounded number and a summary request is none (prompt rule), never a list', () => {
    expect(validateSelection({ entryId: 'mail.list', args: { item: 3 } }, ctx('3번은 누가 보냈어?'))).toMatchObject({ ok: true, value: { args: { item: 3 } } });
    expect(validateSelection({ entryId: 'mail.list', args: { item: 0 } }, ctx('0번'))).toMatchObject({ ok: false, reason: 'invalid-arg' });
    const prompt = buildSelectionPrompt({ entries: [NL_WAVE1_ENTRIES['mail.list']], text: '' });
    expect(prompt).toContain('"그거 요약해줘") is none, not a list');
    expect(prompt).toContain('item: 1-10');
  });
});

describe('review fixes: time-word scope, numeric dates, DST, transient item, future mail range', () => {
  it('numeric dates are time words even with punctuation, and 점심 is not one', () => {
    for (const text of ['10.07', '10/7', '10월 7일', '10.07.', '2026.10.07', '10-07']) expect(isTimeExpression(text), text).toBe(true);
    expect(isTimeExpression('점심')).toBe(false);
    expect(isTimeExpression('점심 회식')).toBe(false);
    expect(validateSelection({ entryId: 'calendar.events', args: { keyword: '10.07' } }, ctx('10.07 거는?'))).toMatchObject({ ok: false, reason: 'time-keyword' });
    expect(validateSelection({ entryId: 'calendar.events', args: { keyword: '점심' } }, ctx('점심 일정만'))).toMatchObject({ ok: true });
  });

  it('a sender named like a weekday stays valid and survives the stored-selection scrub; a title keyword does not', () => {
    expect(validateSelection({ entryId: 'mail.list', args: { from: 'Sun' } }, ctx('Sun이 보낸 메일'))).toMatchObject({ ok: true, value: { args: { from: 'Sun' } } });
    expect(validateSelection({ entryId: 'mail.list', args: { from: '월요일' } }, ctx('월요일 씨 메일'))).toMatchObject({ ok: true });
    expect(migrateStoredSelection({ entryId: 'mail.list', args: { from: 'Sun', range: 'today' } })).toEqual({ entryId: 'mail.list', args: { from: 'Sun', range: 'today' } });
    expect(migrateStoredSelection({ entryId: 'calendar.events', args: { keyword: 'Sun' } }).args).toEqual({});
  });

  it('a mail period in the future is refused; a period that includes now is fine', () => {
    for (const range of ['tomorrow', 'next-week', 'next-wed', 'day-after-tomorrow']) {
      expect(validateSelection({ entryId: 'mail.list', args: { range } }, ctx('내일 온 메일')), range).toMatchObject({ ok: false, reason: 'range' });
    }
    for (const range of ['today', 'this-week', 'yesterday', 'last-fri']) expect(validateSelection({ entryId: 'mail.list', args: { range } }, ctx('메일')), range).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'calendar.events', args: { range: 'tomorrow' } }, ctx('내일'))).toMatchObject({ ok: true });
  });

  it('the new symbols respect DST in America/New_York (the clocks go back on 2026-11-01)', () => {
    const NY = 'America/New_York';
    const now = '2026-10-29T16:00:00.000Z'; // Thursday
    // week-after-next: Monday 2026-11-09 .. 11-16 is after the change (EST, UTC-5); this Monday 10-26 is EDT (UTC-4).
    expect(resolveNlRange('week-after-next', now, NY)).toMatchObject({ from: '2026-11-09T05:00:00.000Z', to: '2026-11-16T05:00:00.000Z' });
    expect(resolveNlRange('this-sun', now, NY)).toMatchObject({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' });
    expect(resolveNlRange('last-fri', now, NY)).toMatchObject({ from: '2026-10-23T04:00:00.000Z', to: '2026-10-24T04:00:00.000Z' });
    // rest-of-month spans the change: 3 days, to the first midnight of November local time... month end is 10-31.
    expect(resolveNlRange('rest-of-month', now, NY)).toMatchObject({ from: '2026-10-29T04:00:00.000Z', to: '2026-11-01T04:00:00.000Z', days: 3 });
  });
});

describe('review delta: transient args are stripped when a stored selection is read', () => {
  it('drops item but keeps the rest', () => {
    expect(migrateStoredSelection({ entryId: 'mail.list', args: { unread: true, item: 2 } })).toEqual({ entryId: 'mail.list', args: { unread: true } });
    const session = { metadata: { 'quoky.lastSelection': lastSelectionRecord('a-1', { entryId: 'mail.list', args: { item: 3, range: 'today' } }, NOW) } };
    expect(readLastSelection(session, 'a-1', NOW)).toMatchObject({ args: { range: 'today' } });
    expect(readLastSelection(session, 'a-1', NOW)?.args).not.toHaveProperty('item');
  });
});

describe('review polish: version numbers are not dates', () => {
  it.each(['2.0', '4.2', 'v4.2', '1.10.3', '0.13', '13.5'])('%s is a keyword, not a time expression', (text) => {
    expect(isTimeExpression(text)).toBe(false);
    expect(validateSelection({ entryId: 'calendar.events', args: { keyword: text } }, ctx(`${text} 릴리스만`))).toMatchObject({ ok: true });
  });
  it.each(['10.07', '10/7', '10월 7일', '2026.10.07', '12/31', '1.15'])('%s is a date', (text) => {
    expect(isTimeExpression(text)).toBe(true);
  });
});
