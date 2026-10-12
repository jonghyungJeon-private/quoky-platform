import { describe, expect, it } from 'vitest';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { guardFalseIncapabilityClaims, renderConfiguredSourcesFact } from './honest-chat';
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
    expect(prepared.text).toContain('[2 attachments omitted]');
    expect(prepared.text).not.toMatch(/jira|삭제/);
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

  it('leaves true statements and unconfigured sources alone', () => {
    for (const reply of ['노션에는 접근할 수 없어요.', 'Jira는 이슈 추적 도구예요.', '메일에는 접근할 수 없어요.', '']) {
      expect(guardFalseIncapabilityClaims(reply, configured, 'ko').guarded).toBe(false);
    }
  });
});
