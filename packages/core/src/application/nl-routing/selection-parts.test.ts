import { describe, expect, it } from 'vitest';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { guardDeadEndActionReplies, guardFalseIncapabilityClaims, renderConfiguredSourcesFact } from './honest-chat';
import { NL_ACTION_ENTRIES } from './action-entries';
import { NL_FENCED_PLACEHOLDER, NL_QUOTED_PLACEHOLDER, isGroundedIn, prepareSelectionInput } from './selection-input';
import { NL_SELECTION_OUTPUT_MAX_BYTES, parseSelectionOutput } from './selection-output';
import { buildSelectionPrompt, NL_SELECTION_PROMPT_VERSION } from './selection-prompt';
import { canonicalArgs, validateSelection, type NlValidationContext } from './selection-validator';
import { isNlRangeSymbol, nlRangeLabel, resolveNlRange } from './symbolic-time';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 D3/D4/D8/D9 pure parts: symbolic time, input preparation, the strict output parser, validation and grounding,
// the provider-neutral prompt and the honest-chat guard. No provider, no clock: `now` is an input everywhere.

const NOW = '2026-10-12T03:00:00.000Z'; // Monday 2026-10-12 12:00 in Asia/Seoul
const TZ = 'Asia/Seoul';
const ALL: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const offered = (entries: readonly NlCatalogEntry[] = ALL) => new Map(entries.map((entry) => [entry.id, entry] as const));
const ctx = (groundingText: string, extra: Partial<NlValidationContext> = {}): NlValidationContext => ({
  offered: offered(),
  groundingText,
  now: NOW,
  timeZone: TZ,
  ...extra,
});

describe('symbolic time (ADR-0120 D4 step 4): Core resolves every period with its clock and QUOKY_TIMEZONE', () => {
  it.each([
    ['today', '2026-10-11T15:00:00.000Z', '2026-10-12T15:00:00.000Z'],
    ['yesterday', '2026-10-10T15:00:00.000Z', '2026-10-11T15:00:00.000Z'],
    ['tomorrow', '2026-10-12T15:00:00.000Z', '2026-10-13T15:00:00.000Z'],
    ['this-week', '2026-10-11T15:00:00.000Z', '2026-10-18T15:00:00.000Z'],
    ['last-week', '2026-10-04T15:00:00.000Z', '2026-10-11T15:00:00.000Z'],
    ['next-week', '2026-10-18T15:00:00.000Z', '2026-10-25T15:00:00.000Z'],
    ['this-weekend', '2026-10-16T15:00:00.000Z', '2026-10-18T15:00:00.000Z'],
    ['this-month', '2026-09-30T15:00:00.000Z', '2026-10-31T15:00:00.000Z'],
    ['last-month', '2026-08-31T15:00:00.000Z', '2026-09-30T15:00:00.000Z'],
    ['last-7-days', '2026-10-05T15:00:00.000Z', '2026-10-12T15:00:00.000Z'],
    ['fri', '2026-10-15T15:00:00.000Z', '2026-10-16T15:00:00.000Z'],
    ['mon', '2026-10-11T15:00:00.000Z', '2026-10-12T15:00:00.000Z'],
    ['next-mon', '2026-10-18T15:00:00.000Z', '2026-10-19T15:00:00.000Z'],
    ['10-20', '2026-10-19T15:00:00.000Z', '2026-10-20T15:00:00.000Z'],
    ['10-01..10-07', '2026-09-30T15:00:00.000Z', '2026-10-07T15:00:00.000Z'],
    ['2026-12-28..01-03', '2026-12-27T15:00:00.000Z', '2027-01-03T15:00:00.000Z'],
  ])('%s → [%s, %s)', (symbol, from, to) => {
    expect(resolveNlRange(symbol, NOW, TZ)).toMatchObject({ from, to });
  });

  it('places `upcoming` from now (not midnight) and keeps day offsets for the named days', () => {
    expect(resolveNlRange('upcoming', NOW, TZ)).toMatchObject({ from: NOW, upcoming: true, days: 14 });
    expect(resolveNlRange('tomorrow', NOW, TZ)).toMatchObject({ dayOffset: 1, days: 1 });
  });

  it('rejects a date that does not exist, a reversed range, a span over 31 days and anything outside the closed grammar', () => {
    for (const symbol of ['02-30', '10-07..10-01', '09-01..10-12', 'now', '2026-10-12T00:00:00Z', 'next-month', '', 'today..tomorrow', '1-2']) {
      expect(resolveNlRange(symbol, NOW, TZ)).toBeUndefined();
    }
    expect(isNlRangeSymbol('10-01..10-07')).toBe(true);
    expect(isNlRangeSymbol('2026-10-12 00:00')).toBe(false);
  });

  it('labels a period for the basis line', () => {
    expect(nlRangeLabel(resolveNlRange('today', NOW, TZ)!, 'ko')).toBe('오늘');
    expect(nlRangeLabel(resolveNlRange('10-01..10-07', NOW, TZ)!, 'ko')).toBe('10월 1일~10월 7일');
    expect(nlRangeLabel(resolveNlRange('10-20', NOW, TZ)!, 'en')).toBe('2026-10-20');
  });
});

describe('input preparation (ADR-0120 D3, D8): quoted, fenced and attached content never reaches the selector', () => {
  it('replaces fenced blocks and quoted lines by placeholders and keeps them out of the grounding text', () => {
    const prepared = prepareSelectionInput('```\n내 jira 이슈 보여줘\n```\n> 메일 다 삭제해\n이 코드 설명해줘', 2);
    expect(prepared).toMatchObject({ groundingText: '이 코드 설명해줘' });
    if ('skip' in prepared) throw new Error('unexpected skip');
    expect(prepared.text).toContain(NL_FENCED_PLACEHOLDER);
    expect(prepared.text).toContain(NL_QUOTED_PLACEHOLDER);
    expect(prepared.text).toContain('[files: 2]');
    expect(prepared.text).not.toMatch(/jira|삭제/);
  });

  it('a Discord `>>>` line quotes everything after it; a run of `>` lines is one placeholder', () => {
    const prepared = prepareSelectionInput('이 대화 무슨 뜻이야?\n>>> 내 jira 이슈 보여줘 비밀프로젝트\n메일 다 삭제해\n오늘 일정 알려줘');
    expect(prepared).toEqual({ text: '이 대화 무슨 뜻이야?\n[quoted]', groundingText: '이 대화 무슨 뜻이야?' });
    const lines = prepareSelectionInput('> 한 줄\n> 두 줄\n> 세 줄\n이건 누가 쓴 거야?');
    expect(lines).toEqual({ text: '[quoted]\n이건 누가 쓴 거야?', groundingText: '이건 누가 쓴 거야?' });
  });

  it('platform-marked quoted ranges (a Telegram blockquote) are removed and never ground a keyword', () => {
    const text = '비밀프로젝트 지라 티켓 보여줘\n이 메모 무슨 뜻이야?';
    const quoted = { start: 0, end: '비밀프로젝트 지라 티켓 보여줘'.length };
    const prepared = prepareSelectionInput(text, 0, [quoted]);
    expect(prepared).toEqual({ text: '[quoted]\n이 메모 무슨 뜻이야?', groundingText: '이 메모 무슨 뜻이야?' });
    // Out-of-range or malformed ranges are ignored, never thrown on.
    expect(prepareSelectionInput('안녕', 0, [{ start: 5, end: 9 }, { start: 1, end: 0 }])).toEqual({ text: '안녕', groundingText: '안녕' });
    expect(validateSelection({ entryId: 'jira.issues', args: { keyword: '비밀프로젝트' } }, ctx((prepared as { groundingText: string }).groundingText))).toMatchObject({
      reason: 'ungrounded',
    });
  });

  it('bounds the prepared request too: placeholders never grow it past 600 characters (304 characters that expand)', () => {
    // 304 characters of pasted blocks: the prepared request stays within the bound.
    const short = `${'`'.repeat(6).repeat(50)} 지라 이슈`;
    expect(Array.from(short).length).toBe(306);
    const prepared = prepareSelectionInput(short);
    expect(prepared).toMatchObject({ groundingText: '지라 이슈' });
    expect(Array.from((prepared as { text: string }).text).length).toBeLessThanOrEqual(600);
    // Under the raw bound, but the placeholders expand past it: skipped, never sent longer than 600.
    const expanding = `${'`'.repeat(6).repeat(90)} 지라 이슈`;
    expect(Array.from(expanding).length).toBeLessThanOrEqual(600);
    expect(prepareSelectionInput(expanding)).toEqual({ skip: 'too-long' });
    expect(prepareSelectionInput('지라 이슈 보여줘', 2)).toEqual({ text: '지라 이슈 보여줘\n[files: 2]', groundingText: '지라 이슈 보여줘' });
  });

  it('skips text over 600 characters and text with nothing of the owner left', () => {
    expect(prepareSelectionInput('가'.repeat(601))).toEqual({ skip: 'too-long' });
    expect(prepareSelectionInput('가'.repeat(600))).not.toHaveProperty('skip');
    expect(prepareSelectionInput('> quoted only')).toEqual({ skip: 'empty' });
  });

  it('grounds verbatim, case- and spacing-insensitively', () => {
    expect(isGroundedIn('위클리카', '그 중에 위클리카만')).toBe(true);
    expect(isGroundedIn('Deploy', 'search slack for deploy notes')).toBe(true);
    expect(isGroundedIn('배포 가이드', '배포  가이드 찾아줘')).toBe(true);
    expect(isGroundedIn('위클리카', '그 중에 위클리 카만')).toBe(false);
  });
});

describe('strict output parser (ADR-0120 D3)', () => {
  const ok = '{"entryId":"jira.issues","args":{"window":"created","range":"today"},"ambiguity":"CLEAR","alternatives":[]}';

  it('accepts the contract, a single code fence, `none`, null args and a logged-only confidence', () => {
    expect(parseSelectionOutput(ok)).toEqual({ entryId: 'jira.issues', args: { window: 'created', range: 'today' }, ambiguity: 'CLEAR', alternatives: [] });
    expect(parseSelectionOutput('```json\n' + ok + '\n```')).not.toBeNull();
    expect(parseSelectionOutput('{"entryId":"none","args":{},"ambiguity":"CLEAR","alternatives":[]}')).toMatchObject({ entryId: null });
    expect(parseSelectionOutput('{"entryId":"slack.search","args":{"keyword":"배포","limit":null},"ambiguity":"CLEAR","confidence":0.9}')).toMatchObject({
      args: { keyword: '배포' },
      confidence: 0.9,
      alternatives: [],
    });
  });

  it('rejects unknown keys, prose, a third alternative, nested args, a bad ambiguity and output over 2 KB', () => {
    for (const raw of [
      ok.replace('"alternatives"', '"reason":"x","alternatives"'),
      `Sure! ${ok}`,
      '{"entryId":"jira.issues","args":{},"ambiguity":"CLEAR","alternatives":[{"entryId":"a.b"},{"entryId":"c.d"},{"entryId":"e.f"}]}',
      '{"entryId":"jira.issues","args":{"x":{"y":1}},"ambiguity":"CLEAR"}',
      '{"entryId":"jira.issues","args":{},"ambiguity":"MAYBE"}',
      '{"entryId":"Jira Issues","args":{},"ambiguity":"CLEAR"}',
      '{"entryId":"jira.issues","args":{},"ambiguity":"CLEAR","alternatives":[{"entryId":"none","args":{}}]}',
      `{"entryId":"jira.issues","args":{"keyword":"${'가'.repeat(250)}"},"ambiguity":"CLEAR"}`,
      `{"entryId":"slack.search","args":{"keyword":"${'a'.repeat(190)}","a":"${'b'.repeat(190)}","b":"${'b'.repeat(190)}","c":"${'b'.repeat(190)}","d":"${'b'.repeat(190)}","e":"${'b'.repeat(190)}","f":"${'b'.repeat(190)}","g":"${'b'.repeat(190)}","h":"${'b'.repeat(190)}","i":"${'b'.repeat(190)}","j":"${'b'.repeat(190)}"},"ambiguity":"CLEAR"}`,
      '[]',
      '',
    ]) {
      expect(parseSelectionOutput(raw)).toBeNull();
    }
    expect(NL_SELECTION_OUTPUT_MAX_BYTES).toBe(2048);
  });
});

describe('deterministic validation (ADR-0120 D4)', () => {
  it('rejects ids outside the closed catalog and entries the turn does not offer (an unconfigured source)', () => {
    expect(validateSelection({ entryId: 'notion.pages', args: {} }, ctx('노션'))).toMatchObject({ ok: false, reason: 'unknown-entry' });
    expect(validateSelection({ entryId: 'mail.list', args: {} }, ctx('메일', { offered: offered([NL_WAVE1_ENTRIES['jira.issues']]) }))).toMatchObject({
      ok: false,
      reason: 'not-offered',
    });
  });

  it('rejects unknown args, values outside the closed sets, bounds and missing required args', () => {
    expect(validateSelection({ entryId: 'jira.issues', args: { jql: 'project = X' } }, ctx(''))).toMatchObject({ reason: 'unknown-arg', arg: 'jql' });
    expect(validateSelection({ entryId: 'jira.issues', args: { role: 'watcher' } }, ctx(''))).toMatchObject({ reason: 'invalid-arg', arg: 'role' });
    expect(validateSelection({ entryId: 'jira.issues', args: { limit: 11 } }, ctx(''))).toMatchObject({ reason: 'invalid-arg', arg: 'limit' });
    expect(validateSelection({ entryId: 'jira.issues', args: { limit: 0 } }, ctx(''))).toMatchObject({ reason: 'invalid-arg' });
    expect(validateSelection({ entryId: 'jira.issues', args: { count: 'yes' } }, ctx(''))).toMatchObject({ reason: 'invalid-arg', arg: 'count' });
    expect(validateSelection({ entryId: 'slack.search', args: {} }, ctx('슬랙'))).toMatchObject({ reason: 'missing-arg', arg: 'keyword' });
  });

  it('resolves time symbolically and refuses a period over 31 days or `upcoming` outside the calendar', () => {
    const result = validateSelection({ entryId: 'jira.issues', args: { window: 'created', range: 'yesterday' } }, ctx(''));
    expect(result).toMatchObject({ ok: true, value: { range: { from: '2026-10-10T15:00:00.000Z', to: '2026-10-11T15:00:00.000Z' } } });
    expect(validateSelection({ entryId: 'jira.issues', args: { window: 'created', range: '01-01..03-01' } }, ctx(''))).toMatchObject({ reason: 'range' });
    // A Jira "다가오는 마감" read as the calendar's `upcoming` is the next 7 days of due dates (entry normalization).
    expect(validateSelection({ entryId: 'jira.issues', args: { window: 'due', range: 'upcoming' } }, ctx(''))).toMatchObject({
      ok: true,
      value: { args: { window: 'due', range: 'next-7-days' } },
    });
    expect(validateSelection({ entryId: 'calendar.events', args: { range: 'Friday' } }, ctx(''))).toMatchObject({ ok: true, value: { args: { range: 'fri' } } });
    expect(validateSelection({ entryId: 'calendar.events', args: { range: 'next-monday' } }, ctx(''))).toMatchObject({ value: { args: { range: 'next-mon' } } });
    expect(validateSelection({ entryId: 'calendar.events', args: { range: 'upcoming' } }, ctx(''))).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'calendar.events', args: { range: '2026-10-12T09:00' } }, ctx(''))).toMatchObject({ reason: 'invalid-arg' });
  });

  it('canonicalizes a search keyword by dropping a trailing generic noun (never the only word)', () => {
    expect(validateSelection({ entryId: 'confluence.search', args: { keyword: '온보딩 문서' } }, ctx('컨플루언스에서 온보딩 문서 검색해줘'))).toMatchObject({
      value: { args: { keyword: '온보딩' } },
    });
    expect(validateSelection({ entryId: 'drive.files', args: { name: '문서' } }, ctx('드라이브 문서 찾아줘'))).toMatchObject({ value: { args: { name: '문서' } } });
  });

  it('grounds keywords in the owner text or the previous selection only, and runs the credential guard on every string', () => {
    expect(validateSelection({ entryId: 'jira.issues', args: { keyword: '결제' } }, ctx('내 지라 이슈'))).toMatchObject({ reason: 'ungrounded', arg: 'keyword' });
    expect(validateSelection({ entryId: 'jira.issues', args: { keyword: '결제' } }, ctx('결제 관련 지라 이슈'))).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'jira.issues', args: { keyword: '결제' } }, ctx('그것만', { previousArgs: { keyword: '결제' } }))).toMatchObject({ ok: true });
    const secret = 'ghp_' + 'a'.repeat(36);
    expect(validateSelection({ entryId: 'slack.search', args: { keyword: secret } }, ctx(`슬랙에서 ${secret} 검색`))).toMatchObject({ reason: 'credential' });
  });

  it('grounds the Jira in-progress status like a role: the owner says it or it carries over, a guess is refused', () => {
    const inProgress = { entryId: 'jira.issues', args: { status: 'in-progress' } } as const;
    expect(validateSelection(inProgress, ctx('내 지라 이슈'))).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'status' });
    for (const text of ['진행중인 이슈만 보여줄래', '지금 진행 중인 지라 티켓', 'jira issues in progress', 'what am I working on in jira', '진행하고 있는 일']) {
      expect(validateSelection(inProgress, ctx(text)), text).toMatchObject({ ok: true, value: { args: { status: 'in-progress' } } });
    }
    expect(validateSelection(inProgress, ctx('그 중에 결제만', { previousArgs: { status: 'in-progress' } }))).toMatchObject({ ok: true });
    expect(validateSelection(inProgress, ctx('그 중에 결제만', { previousArgs: { status: 'all' } }))).toMatchObject({ reason: 'ungrounded' });
    // the other values stay ungrounded-free, and an unknown value is still invalid
    expect(validateSelection({ entryId: 'jira.issues', args: { status: 'all' } }, ctx('내 지라 이슈'))).toMatchObject({ ok: true });
    expect(validateSelection({ entryId: 'jira.issues', args: { status: 'blocked' } }, ctx('진행'))).toMatchObject({ reason: 'invalid-arg', arg: 'status' });
  });

  it('grounds the Drive kind in the owner words (스프레드시트/시트/엑셀, 독스, 슬라이드, pdf, 폴더) and never guesses it', () => {
    const kind = (value: string, text: string) => validateSelection({ entryId: 'drive.files', args: { kind: value } }, ctx(text));
    expect(kind('spreadsheet', '드라이브 파일 최근 거')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'kind' });
    expect(kind('spreadsheet', '구글 드라이브에 스프레드시트 최근 거')).toMatchObject({ ok: true, value: { args: { kind: 'spreadsheet' } } });
    for (const [value, text] of [['spreadsheet', '드라이브 엑셀'], ['spreadsheet', 'drive sheet'], ['document', '드라이브 독스'], ['document', '구글 문서 최근 거'], ['document', 'google docs on drive'], ['presentation', '드라이브 슬라이드'], ['presentation', '드라이브 ppt'], ['pdf', '드라이브 PDF'], ['folder', '드라이브 폴더']] as const) {
      expect(kind(value, text), text).toMatchObject({ ok: true });
    }
    // a plain 문서 is not a type; docker is not docs (word boundary); sheets/PDFs plural still ground
    for (const text of ['기획 문서 찾아줘', '드라이브 최근 문서', 'docker 이미지 문서', 'drive docker files', 'documents on drive']) {
      expect(kind('document', text), text).toMatchObject({ ok: false, reason: 'ungrounded' });
    }
    expect(kind('spreadsheet', 'recent sheets on drive')).toMatchObject({ ok: true });
    expect(kind('spreadsheet', 'drive datasheet')).toMatchObject({ ok: false });
    expect(kind('pdf', '그 중에 최근 거')).toMatchObject({ ok: false });
    expect(validateSelection({ entryId: 'drive.files', args: { kind: 'pdf' } }, ctx('그 중에 최근 거', { previousArgs: { kind: 'pdf' } }))).toMatchObject({ ok: true });
    expect(kind('executable', '드라이브 exe')).toMatchObject({ reason: 'invalid-arg', arg: 'kind' });
    const ok = kind('spreadsheet', '드라이브 시트');
    if (ok.ok) expect(ok.value.entry.describe?.(ok.value.args, undefined, 'ko')).toBe('최근 스프레드시트');
  });

  it('describes the Jira in-progress basis and the calendar keyword basis', () => {
    const jira = NL_WAVE1_ENTRIES['jira.issues'];
    expect(jira.describe?.({ status: 'in-progress' }, undefined, 'ko')).toBe('내가 담당 / 진행 중');
    expect(jira.describe?.({ status: 'in-progress' }, undefined, 'en')).toBe('assigned to me / in progress');
    const calendar = validateSelection({ entryId: 'calendar.events', args: { keyword: '스크럼' } }, ctx('오늘 스크럼 있어?'));
    expect(calendar).toMatchObject({ ok: true, value: { args: { keyword: '스크럼' } } });
    if (!calendar.ok) return;
    expect(calendar.value.entry.describe?.(calendar.value.args, calendar.value.range, 'ko')).toBe('오늘 일정 / "스크럼" 포함');
  });

  it('grounds the calendar keyword in the owner text or the previous selection, and never in titles', () => {
    expect(validateSelection({ entryId: 'calendar.events', args: { keyword: '스크럼' } }, ctx('이번 주 일정'))).toMatchObject({ reason: 'ungrounded', arg: 'keyword' });
    expect(validateSelection({ entryId: 'calendar.events', args: { range: 'this-week', keyword: '스크럼' } }, ctx('그 중에 스크럼만', { previousArgs: { range: 'this-week' } }))).toMatchObject({
      ok: true,
      value: { args: { range: 'this-week', keyword: '스크럼' } },
    });
    expect(validateSelection({ entryId: 'calendar.events', args: { keyword: '스크럼' } }, ctx('그것만', { previousArgs: { keyword: '스크럼' } }))).toMatchObject({ ok: true });
  });

  it('normalizes the Jira period (a period word without a date field is dropped; a field gets its natural window)', () => {
    expect(validateSelection({ entryId: 'jira.issues', args: { range: 'today', role: 'assignee' } }, ctx(''))).toMatchObject({ ok: true, value: { args: {} } });
    expect(validateSelection({ entryId: 'jira.issues', args: { window: 'due' } }, ctx(''))).toMatchObject({ value: { args: { window: 'due', range: 'this-week' } } });
    expect(validateSelection({ entryId: 'jira.issues', args: { window: 'created' } }, ctx(''))).toMatchObject({
      value: { args: { window: 'created', range: 'today' }, openAmbiguity: { key: 'jira.created-scope' } },
    });
  });

  it('keeps an explicit role while the created-scope key is in force, and drops defaults everywhere else', () => {
    const entry = NL_WAVE1_ENTRIES['jira.issues'];
    expect(canonicalArgs(entry, { window: 'created', range: 'today', role: 'assignee', status: 'open' })).toEqual({ window: 'created', range: 'today', role: 'assignee' });
    expect(canonicalArgs(entry, { role: 'assignee', status: 'all', count: false })).toEqual({ status: 'all' });
    expect(canonicalArgs(NL_WAVE1_ENTRIES['calendar.events'], { range: 'today', remaining: false })).toEqual({});
    expect(canonicalArgs(NL_WAVE1_ENTRIES['help.topic'], { topic: 'all' })).toEqual({});
  });

  it('never accepts a write entry: wave 1 is READ only', () => {
    const write = { ...NL_WAVE1_ENTRIES['todo.list'], risk: 'LOCAL_WRITE' as const };
    expect(validateSelection({ entryId: 'todo.list', args: {} }, ctx('', { offered: offered([write]) }))).toMatchObject({ reason: 'not-read' });
  });
});

describe('the selection prompt (ADR-0120 D2/D8): provider-neutral, catalog + previous structure + prepared text only', () => {
  it('lists only the offered entries and carries the previous selection as structure', () => {
    const prompt = buildSelectionPrompt({
      entries: [NL_WAVE1_ENTRIES['jira.issues'], NL_WAVE1_ENTRIES['help.topic']],
      text: '그 중에 위클리카만',
      previous: { entryId: 'jira.issues', args: { window: 'created', range: 'today' } },
    });
    expect(prompt).toContain('- jira.issues:');
    expect(prompt).toContain('- help.topic:');
    expect(prompt).not.toContain('- mail.list:');
    expect(prompt).not.toContain('slack.search');
    expect(prompt).toContain('Previous selection: {"entryId":"jira.issues","args":{"window":"created","range":"today"}}');
    expect(prompt.endsWith('<<<\n그 중에 위클리카만\n>>>')).toBe(true);
    expect(NL_SELECTION_PROMPT_VERSION).toMatch(/^nl-select\.v\d+$/);
  });

  it('names no provider, model or platform (Core stays provider-neutral)', () => {
    const prompt = buildSelectionPrompt({ entries: ALL, text: 'x' });
    expect(prompt).not.toMatch(/\b(?:claude|anthropic|haiku|sonnet|opus|codex|openai|gemini|ollama|discord|telegram)\b/i);
  });
});

describe('honest chat (ADR-0120 D9)', () => {
  const configured = [NL_WAVE1_ENTRIES['jira.issues'], NL_WAVE1_ENTRIES['calendar.events'], NL_WAVE1_ENTRIES['help.topic']];

  it('lists the configured sources and their commands in one Core fact', () => {
    const fact = renderConfiguredSourcesFact(configured)!;
    expect(fact).toContain('Jira issues (command: "내 Jira 이슈 보여줘")');
    expect(fact).toContain('Calendar events (command: "오늘 일정")');
    expect(fact).toContain('Sources not listed are not connected.');
    expect(renderConfiguredSourcesFact([NL_WAVE1_ENTRIES['help.topic']])).toBeUndefined();
    // D5: the help lines go along, so a write request is answered with the exact anchored command (suggestion only).
    const withCommands = renderConfiguredSourcesFact(configured, ['- 할 일: "할 일 추가: 내용", "완료 처리: 번호"'])!;
    expect(withCommands).toContain('Quoky\'s own commands (the User sends them exactly; a chat reply cannot run them or do the action): 할 일: "할 일 추가: 내용", "완료 처리: 번호".');
  });

  it.each([
    ['죄송하지만 저는 Jira에 직접 접근할 수 없어요.', 'ko'],
    ['지라 연동이 되어 있지 않아서 확인이 어렵습니다. 저는 지라에 연결할 수 없어요.', 'ko'],
    ["I can't access your Jira tickets directly.", 'en'],
    ['I do not have access to your calendar.', 'en'],
  ] as const)('replaces a false incapability claim about a configured source: %s', (reply, language) => {
    const guarded = guardFalseIncapabilityClaims(reply, configured, language);
    expect(guarded.guarded).toBe(true);
    expect(guarded.text).toMatch(/내 Jira 이슈 보여줘|오늘 일정/);
  });

  it('never erases a correct write answer: write verbs are not access claims, and a reply naming a command is kept', () => {
    const configuredWithMail = [...configured, NL_WAVE1_ENTRIES['mail.list']];
    const help = ['- 메일 보내기: "메일 보내기: 받는사람 내용"', '- 할 일: "할 일 추가: 내용"'];
    for (const reply of [
      '메일을 직접 보낼 수 없어요. "메일 보내기:" 명령을 보내 주세요.',
      '지라 이슈를 가져올 수 없어요.',
      '캘린더에 일정을 만들 수는 없어요. "할 일 추가: 회의 준비"처럼 보내 주세요.',
      '저는 Jira에 접근할 수 없어요. 대신 "내 Jira 이슈 보여줘"라고 보내 주세요.',
    ]) {
      expect(guardFalseIncapabilityClaims(reply, configuredWithMail, 'ko', help), reply).toEqual({ text: reply, guarded: false });
    }
    // Still a false claim without a command: replaced.
    expect(guardFalseIncapabilityClaims('메일을 읽을 수 없어요.', configuredWithMail, 'ko', help).guarded).toBe(true);
  });

  it('guards the help-index deflection and every read-incapability phrasing, but keeps an action-command offer', () => {
    const help = ['- 도움말: "도움말"', '- 도움말: "help"', '- 메일 보내기: "메일 보내기: 받는사람 내용"'];
    const withMail = [...configured, NL_WAVE1_ENTRIES['mail.list']];
    for (const reply of [
      'Jira에 접근할 수 없어요. 도움말을 확인해 주세요.',
      '지라 이슈를 볼 수 없어요.',
      'Jira에 접근할 수 없어요.',
      '지라 이슈를 조회할 수 없어요.',
      '지라가 연결되어 있지 않아요.',
    ]) {
      expect(guardFalseIncapabilityClaims(reply, withMail, 'ko', help).guarded, reply).toBe(true);
    }
    const kept = '메일을 직접 보낼 수 없어요. "메일 보내기:" 명령을 보내 주세요.';
    expect(guardFalseIncapabilityClaims(kept, withMail, 'ko', help)).toEqual({ text: kept, guarded: false });
  });

  it('leaves true statements and unconfigured sources alone', () => {
    for (const reply of ['노션에는 접근할 수 없어요.', 'Jira는 이슈 추적 도구예요.', '메일에는 접근할 수 없어요.', '']) {
      expect(guardFalseIncapabilityClaims(reply, configured, 'ko').guarded).toBe(false);
    }
  });

  it('A6 live test 4 (turns 39, 53): while actions are offered, a yes/no offer of an action or a false "cannot" about one becomes the restate', () => {
    const withActions = [...configured, ...Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined)];
    const restate = '무엇을/어느 항목을 다시 말씀해 주세요.';
    // CA P2 (2026-10-19): offers and denials in every form are handled alike ("리마인더로 만들어 드릴까요?", "…해 드릴 수는 없어요").
    for (const reply of ['3번도 완료할까요?', '할 일은 제가 직접 취소할 수 없어요.', 'Shall I add it to your to-do list?', "I can't remove items from your to-do list here.", '리마인더로 만들어 드릴까요?', '저는 할 일을 대신 해 드릴 수는 없어요.', '할 일에 넣어 드릴까요?']) {
      expect(guardFalseIncapabilityClaims(reply, withActions, 'ko'), reply).toEqual({ text: restate, guarded: true });
    }
    // CA P2: only the offending sentence goes; true sentences stay as written.
    expect(guardFalseIncapabilityClaims('할 일 3번은 이미 완료됐어요. 4번도 완료할까요?', withActions, 'ko')).toEqual({ text: `할 일 3번은 이미 완료됐어요. ${restate}`, guarded: true });
    // Codex P2: list grounding is per sentence; an explicit anaphor carries the previous sentence's list over.
    expect(guardFalseIncapabilityClaims('방금 추가한 할 일을 취소하고 싶으시군요. 그건 제가 직접 취소할 수 없어요.', withActions, 'ko')).toEqual({ text: `방금 추가한 할 일을 취소하고 싶으시군요. ${restate}`, guarded: true });
    const explanation = 'Your todo list is ready. Shall I add more detail to this explanation?';
    expect(guardFalseIncapabilityClaims(explanation, withActions, 'en')).toEqual({ text: explanation, guarded: false });
    const unrelated = 'Your todo list is ready. Shall I add a summary of the weather?';
    expect(guardFalseIncapabilityClaims(unrelated, withActions, 'en')).toEqual({ text: unrelated, guarded: false });
    expect(guardFalseIncapabilityClaims('I see the item on your to-do list. Shall I add it?', withActions, 'en')).toEqual({ text: 'I see the item on your to-do list. Please tell me again what to do and which item.', guarded: true });
    // Recorded residual (best-effort guard): a denial with neither a list noun nor an anaphor in its own sentence is kept.
    const residual = '방금 추가한 할 일을 취소하고 싶으시군요. 여기서는 제가 직접 취소할 수 없어요.';
    expect(guardFalseIncapabilityClaims(residual, withActions, 'ko')).toEqual({ text: residual, guarded: false });
    // Offers of nothing Quoky writes (Codex P2: 추가로 is no add), how-to and explanation offers (CA P2), true statements
    // about read-only sources, and families that are not offered stay.
    for (const reply of ['더 자세히 알려드릴까요?', '추가로 설명해 드릴까요?', '할 일 사용법을 추가로 설명해 드릴까요?', '할 일 목록을 추가로 보여드릴까요?', '할 일에 추가하는 방법을 알려드릴까요?', '할 일 3번은 이미 완료됐어요.', '캘린더 일정은 제가 취소할 수 없어요. 할 일은 말씀만 하세요.', '좋아요!']) {
      expect(guardDeadEndActionReplies(reply, withActions, 'ko'), reply).toEqual({ text: reply, guarded: false });
    }
    expect(guardFalseIncapabilityClaims('3번도 완료할까요?', configured, 'ko')).toEqual({ text: '3번도 완료할까요?', guarded: false });
    // Codex P2: list nouns and verbs come from the offered families; with reminders not offered the reminder denial is true.
    const todosOnly = [...configured, ...Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined && !entry.id.startsWith('reminder.'))];
    const denial = '리마인더를 대신 만들어 드릴 수는 없어요.';
    expect(guardFalseIncapabilityClaims(denial, todosOnly, 'ko')).toEqual({ text: denial, guarded: false });
    expect(guardFalseIncapabilityClaims('리마인더로 만들어 드릴까요?', todosOnly, 'ko')).toEqual({ text: '리마인더로 만들어 드릴까요?', guarded: false });
    expect(guardFalseIncapabilityClaims(denial, withActions, 'ko')).toEqual({ text: restate, guarded: true });
    // Codex P2: the dead-end filter is partial; the rest of the reply still meets the source-incapability check.
    const withMail = [NL_WAVE1_ENTRIES['mail.list'], ...withActions];
    const mixed = guardFalseIncapabilityClaims('할 일을 추가할까요? 메일은 읽을 수 없어요.', withMail, 'ko');
    expect(mixed.guarded).toBe(true);
    expect(mixed.text).toContain('Quoky가 연결되어 있어서 바로 조회할 수 있어요.');
    expect(mixed.text).not.toContain('메일은 읽을 수 없어요');
    // Only the action offer: the partial filter's own result is returned.
    expect(guardFalseIncapabilityClaims('할 일 3번은 이미 완료됐어요. 4번도 완료할까요?', withMail, 'ko')).toEqual({ text: `할 일 3번은 이미 완료됐어요. ${restate}`, guarded: true });
    // Codex P2: a timed reminder offer counts with no list noun while reminders are offered; with reminders off it stays.
    expect(guardFalseIncapabilityClaims('내일 9시에 알려드릴까요?', withActions, 'ko')).toEqual({ text: restate, guarded: true });
    expect(guardFalseIncapabilityClaims('내일 9시에 알려드릴 수는 없어요.', withActions, 'ko')).toEqual({ text: restate, guarded: true });
    expect(guardFalseIncapabilityClaims('내일 9시에 알려드릴까요?', todosOnly, 'ko')).toEqual({ text: '내일 9시에 알려드릴까요?', guarded: false });
    expect(guardFalseIncapabilityClaims('내일 9시에 알려드릴 수는 없어요.', todosOnly, 'ko')).toEqual({ text: '내일 9시에 알려드릴 수는 없어요.', guarded: false });
    expect(guardFalseIncapabilityClaims('더 자세히 알려드릴까요?', withActions, 'ko')).toEqual({ text: '더 자세히 알려드릴까요?', guarded: false });
  });

  it('A6 live test 4: the configured-sources fact tells the chat never to deny or offer an offered action as a yes/no question', () => {
    const withActions = [...configured, ...Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined)];
    expect(renderConfiguredSourcesFact(withActions, ['- 할 일 추가: "할 일 추가: 내용"'])).toContain('It never says Quoky cannot do them, and never offers one as a yes/no question');
  });
});
