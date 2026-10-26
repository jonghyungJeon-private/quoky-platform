import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM harness modules without type declarations (tools/ is outside the TypeScript build)
import { calendarFacts, duration, relDay } from './facts.mjs';
// @ts-expect-error plain ESM harness module
import { buildJudgeSchema, checkOrdinals, rankedBounds, validateAgainstSchema } from './schema.mjs';
// @ts-expect-error plain ESM harness module
import { CRITERIA_HINT, FALLBACK_HINT, invalidPlaceholders, itemLabel, renderFallback, renderJudge, substitute } from './render.mjs';
// @ts-expect-error plain ESM harness module
import { CORRECTIONS, CHECKS, guardOutput, hasTimeOrDate } from './guards.mjs';
// @ts-expect-error plain ESM harness module
import { adaptTuningSet, coverage, validateCase, validateSet } from './cases.mjs';
// @ts-expect-error plain ESM harness module
import { HARNESS_FILES, PROMPT_PATH, RUBRIC_PATH, checkCommitOrder, checkFreeze, checkModelManifest, fileHasher, parseFreezeEntries, sha256, verifyAll } from './freeze.mjs';
// @ts-expect-error plain ESM harness module
import { blindKey, blindOrder, decide, latencySummary, retryAllowed, usablePlus } from './score.mjs';
// @ts-expect-error plain ESM harness module
import { buildRequestBody, buildUserMessage } from './request.mjs';

// The G6 harness (ADR-0121 A3a). No model call and no Ollama call anywhere in this file: every module under test is
// pure, and the freeze check runs on temporary directories with an injected git.

const REPO = resolve(__dirname, '../..');
const TZ = 'Asia/Seoul';
const NOW = '2026-11-11T09:00:00+09:00'; // a Wednesday

type Item = Record<string, unknown>;
function cal(summary: string, start: string, end: string, extra: Item = {}): Item {
  return { summary, start: `2026-11-12T${start}:00+09:00`, end: `2026-11-12T${end}:00+09:00`, ...extra };
}

const calendarCase = {
  id: 'c-1',
  source: 'calendar',
  lang: 'ko',
  ownerRequest: '목요일 일정 순서 정해줘',
  select: 'order',
  now: NOW,
  items: [cal('신제품 가격 확정 회의', '10:00', '11:30'), cal('팀 점심', '11:00', '12:00'), cal('예산 보고', '12:05', '13:00')],
};

describe('judge.v1 schema builder', () => {
  it('ranks every item for order, with an ordinal enum of 1..N', () => {
    const s = buildJudgeSchema({ select: 'order', n: 4 });
    expect(s.properties.ranked.minItems).toBe(4);
    expect(s.properties.ranked.maxItems).toBe(4);
    expect(s.properties.ranked.items.properties.n.enum).toEqual([1, 2, 3, 4]);
    expect(s.required).toEqual(['intro', 'ranked', 'extra']);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.extra.maxItems).toBe(3);
  });

  it('uses min(count, N) for pick with count and 1..N without', () => {
    expect(rankedBounds({ select: 'pick', count: 2, n: 5 })).toEqual([2, 2]);
    expect(rankedBounds({ select: 'pick', count: 7, n: 3 })).toEqual([3, 3]);
    expect(rankedBounds({ select: 'pick', n: 5 })).toEqual([1, 5]);
    const s = buildJudgeSchema({ select: 'pick', count: 9, n: 4 });
    expect([s.properties.ranked.minItems, s.properties.ranked.maxItems]).toEqual([4, 4]);
  });

  it('refuses requests the validator refuses (V11, count range, select)', () => {
    expect(() => rankedBounds({ select: 'order', count: 2, n: 3 })).toThrow(/V11/);
    expect(() => rankedBounds({ select: 'pick', count: 0, n: 3 })).toThrow();
    expect(() => rankedBounds({ select: 'pick', count: 11, n: 3 })).toThrow();
    expect(() => rankedBounds({ select: 'pick', count: 1.5, n: 3 })).toThrow();
    expect(() => rankedBounds({ select: 'rank', n: 3 })).toThrow();
  });

  it('validates outputs against the exact request schema', () => {
    const s = buildJudgeSchema({ select: 'pick', count: 2, n: 3 });
    const ok = { intro: '', ranked: [{ n: 1, why: 'a' }, { n: 3, why: 'b' }], extra: [] };
    expect(validateAgainstSchema(s, ok)).toEqual([]);
    expect(validateAgainstSchema(s, { ...ok, more: 1 })).toContain('$: extra key more');
    expect(validateAgainstSchema(s, { ...ok, ranked: [{ n: 1, why: 'a' }] })).toContain('$.ranked: fewer than 2 items');
    expect(validateAgainstSchema(s, { ...ok, ranked: [{ n: 4, why: 'a' }, { n: 1, why: 'b' }] })).toContain('$.ranked[0].n: not in enum');
    expect(validateAgainstSchema(s, { ...ok, intro: 'x'.repeat(151) })).toContain('$.intro: longer than 150');
    expect(validateAgainstSchema(s, { ...ok, extra: ['a', 'b', 'c', 'd'] })).toContain('$.extra: more than 3 items');
    expect(validateAgainstSchema(s, { intro: '', ranked: [] })).toContain('$: missing extra');
  });
});

describe('ordinal validation', () => {
  const req = { select: 'order', n: 3 };
  it('requires unique ordinals in range and the shape count', () => {
    expect(checkOrdinals([{ n: 1 }, { n: 2 }, { n: 3 }], req)).toBeNull();
    expect(checkOrdinals([{ n: 1 }, { n: 1 }, { n: 3 }], req)).toBe('ordinal-unique');
    expect(checkOrdinals([{ n: 0 }, { n: 2 }, { n: 3 }], req)).toBe('ordinal-range');
    expect(checkOrdinals([{ n: 1 }, { n: 2 }, { n: 4 }], req)).toBe('ordinal-range');
    expect(checkOrdinals([{ n: 1.5 }, { n: 2 }, { n: 3 }], req)).toBe('ordinal-range');
    expect(checkOrdinals([{ n: 1 }, { n: 2 }], req)).toBe('select-shape');
  });
  it('applies min(count, N) for pick', () => {
    expect(checkOrdinals([{ n: 2 }, { n: 1 }, { n: 3 }], { select: 'pick', count: 5, n: 3 })).toBeNull();
    expect(checkOrdinals([{ n: 2 }], { select: 'pick', count: 5, n: 3 })).toBe('select-shape');
    expect(checkOrdinals([{ n: 2 }], { select: 'pick', n: 3 })).toBeNull();
    expect(checkOrdinals([{ n: 2 }, { n: 3 }], { select: 'pick', count: 1, n: 3 })).toBe('select-shape');
  });
});

describe('A3a-D3 calendar facts', () => {
  it('rounds duration to 5 minutes and names all-day and multi-day items', () => {
    expect(duration(cal('a', '10:00', '11:27'))).toBe(85);
    expect(duration(cal('a', '10:00', '11:30'))).toBe(90);
    expect(duration(cal('a', '10:00', '10:02'))).toBe(5);
    expect(duration({ summary: 'a', start: '2026-11-12', end: '2026-11-13' })).toBe('종일');
    expect(duration({ summary: 'a', start: '2026-11-12', end: '2026-11-15' })).toBe('3일');
    expect(duration({ summary: 'a', start: '2026-11-12T09:00:00+09:00', end: '2026-11-14T09:00:00+09:00' })).toBe('2일');
  });

  it('computes strict overlap, back-to-back (0–10 min) and gapBefore on the same day', () => {
    const items = [
      cal('A', '10:00', '11:00'),
      cal('B', '10:30', '11:30'), // overlaps A
      cal('C', '11:30', '12:00'), // touches B: not overlap, gap 0
      cal('D', '12:08', '12:20'), // gap 8
      cal('E', '12:30', '12:40'), // gap 10
      cal('F', '12:51', '13:00'), // gap 11
      { summary: 'G', start: '2026-11-13T09:00:00+09:00', end: '2026-11-13T10:00:00+09:00' }, // next day, first
    ];
    const f = calendarFacts(items, NOW, TZ);
    expect(f[0].overlapsWith).toEqual([2]);
    expect(f[1].overlapsWith).toEqual([1]);
    expect(f[2].overlapsWith).toEqual([]);
    expect(f[0].gapBefore).toBeUndefined();
    expect(f[1].gapBefore).toBeUndefined(); // only an overlapping predecessor
    expect([f[2].gapBefore, f[2].backToBack]).toEqual([0, true]);
    expect([f[3].gapBefore, f[3].backToBack]).toEqual([8, true]);
    expect([f[4].gapBefore, f[4].backToBack]).toEqual([10, true]);
    expect([f[5].gapBefore, f[5].backToBack]).toEqual([11, false]);
    expect(f[6].gapBefore).toBeUndefined();
    expect(f[6].backToBack).toBe(false);
    expect(f.map((x: { n: number }) => x.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps all-day items out of the interval facts', () => {
    const f = calendarFacts([{ summary: '휴가', start: '2026-11-12', end: '2026-11-13' }, cal('A', '10:00', '11:00')], NOW, TZ);
    expect(f[0]).toMatchObject({ duration: '종일', overlapsWith: [], backToBack: false });
    expect(f[1].overlapsWith).toEqual([]);
  });

  it('names relDay in the set time zone with Monday weeks', () => {
    const at = (d: string) => relDay(`${d}T10:00:00+09:00`, NOW, TZ);
    expect(at('2026-11-11')).toBe('오늘');
    expect(at('2026-11-12')).toBe('내일');
    expect(at('2026-11-13')).toBe('모레');
    expect(at('2026-11-14')).toBe('이번 주 토요일');
    expect(at('2026-11-15')).toBe('이번 주 일요일');
    expect(at('2026-11-16')).toBe('다음 주 월요일');
    expect(at('2026-11-22')).toBe('다음 주 일요일');
    expect(at('2026-11-25')).toBe('14일 뒤');
    expect(at('2026-11-10')).toBe('어제');
    expect(at('2026-11-08')).toBe('3일 전');
    expect(relDay('2026-11-11T16:00:00Z', NOW, TZ)).toBe('내일'); // 01:00 KST on the 12th
    expect(relDay('2026-11-12', NOW, TZ)).toBe('내일');
  });

  it('puts the facts into the user message for calendar only', () => {
    const msg = buildUserMessage(calendarCase, TZ);
    expect(msg).toContain('요청 형식: order');
    expect(msg).toContain('1: relDay=내일 | duration=90분 | overlapsWith=[2] | backToBack=no');
    expect(msg).toContain('3: relDay=내일 | duration=55분 | overlapsWith=[] | backToBack=yes | gapBefore=5분');
    const todo = { ...calendarCase, source: 'todo', items: [{ title: 'a' }, { title: 'b' }] };
    expect(buildUserMessage(todo, TZ)).not.toContain('시스템이 계산한 사실');
  });

  it('builds the Ollama body per arm with the request schema and no other model settings', () => {
    const l0 = buildRequestBody({ systemPrompt: 'S', testCase: calendarCase, timeZone: TZ, arm: 'L0' });
    const lt = buildRequestBody({ systemPrompt: 'S', testCase: calendarCase, timeZone: TZ, arm: 'LT', correction: 'C' });
    expect(l0).toMatchObject({ model: 'qwen3:8b', stream: false, think: false, options: { temperature: 0.2 } });
    expect(l0.format.properties.ranked.minItems).toBe(3);
    expect(lt.think).toBe(true);
    expect(lt.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'user']);
    expect(() => buildRequestBody({ systemPrompt: 'S', testCase: calendarCase, timeZone: TZ, arm: 'L9' })).toThrow();
  });
});

describe('A3a-D2 renderer', () => {
  it('writes Core labels per source', () => {
    const ctx = { lang: 'ko', timeZone: TZ };
    expect(itemLabel('calendar', calendarCase.items[0], ctx)).toBe('11/12(목) 10:00–11:30 신제품 가격 확정 회의');
    expect(itemLabel('calendar', calendarCase.items[0], { lang: 'en', timeZone: TZ })).toBe('11/12(Thu) 10:00–11:30 신제품 가격 확정 회의');
    expect(itemLabel('calendar', { summary: '워크숍', start: '2026-11-12', end: '2026-11-14' }, ctx)).toBe('11/12(목)–11/13(금) 워크숍');
    expect(itemLabel('calendar', { summary: '휴가', start: '2026-11-12', end: '2026-11-13' }, ctx)).toBe('11/12(목) 종일 휴가');
    expect(itemLabel('jira', { key: 'INT-8', summary: '외부 API 키 발급 대기', status: 'Blocked' }, ctx)).toBe('INT-8(외부 API 키 발급 대기)');
    expect(itemLabel('mail', { from: 'Legal <legal@example.test>', subject: 'Sign today', receivedAt: 'x' }, ctx)).toBe('Sign today (Legal)');
    expect(itemLabel('github', { repo: 'acme/web', number: 420, kind: 'pr', title: '캐시 정책 변경' }, ctx)).toBe('acme/web#420 캐시 정책 변경');
    expect(itemLabel('todo', { title: '보고서\n정리' }, ctx)).toBe('보고서 정리');
  });

  it('substitutes item, time and end placeholders', () => {
    expect(substitute('{item:2}와 겹쳐요', calendarCase, TZ)).toBe('11/12(목) 11:00–12:00 팀 점심와 겹쳐요');
    expect(substitute('{time:1}부터 {end:1}까지', calendarCase, TZ)).toBe('11월 12일(목) 10:00부터 11:30까지');
    expect(substitute('{time:1}', { ...calendarCase, lang: 'en' }, TZ)).toBe('Thu Nov 12 10:00');
    expect(() => substitute('{time:1}', { ...calendarCase, source: 'todo', items: [{ title: 'a' }] }, TZ)).toThrow();
  });

  it('flags every placeholder that is not valid for the case', () => {
    const ctx = { source: 'calendar', n: 3 };
    expect(invalidPlaceholders('{item:1} {time:3} {end:2}', ctx)).toEqual([]);
    expect(invalidPlaceholders('{item:0} {item:4} {foo} {item: 1} {title:1}', ctx)).toEqual(['{item:0}', '{item:4}', '{foo}', '{item: 1}', '{title:1}']);
    expect(invalidPlaceholders('{time:1}', { source: 'jira', n: 3 })).toEqual(['{time:1}']);
    expect(invalidPlaceholders('{item:1}', { source: 'jira', n: 3 })).toEqual([]);
  });

  it('renders order as numbered lines, pick as bullets, and the extra caption', () => {
    const out = { intro: '겹치는 것부터 보세요.', ranked: [{ n: 2, why: '{item:1}과 겹쳐요.' }, { n: 1, why: '길어요.' }, { n: 3, why: '' }], extra: ['{time:3} 전에 자료 확인'] };
    expect(renderJudge(out, calendarCase, TZ)).toBe(
      [
        '겹치는 것부터 보세요.',
        '',
        '1. 11/12(목) 11:00–12:00 팀 점심 — 11/12(목) 10:00–11:30 신제품 가격 확정 회의과 겹쳐요.',
        '2. 11/12(목) 10:00–11:30 신제품 가격 확정 회의 — 길어요.',
        '3. 11/12(목) 12:05–13:00 예산 보고',
        '',
        '함께 챙기면 좋은 점',
        '- 11월 12일(목) 12:05 전에 자료 확인',
      ].join('\n'),
    );
    const pick = renderJudge({ intro: '', ranked: [{ n: 3, why: '중요해요.' }], extra: [] }, { ...calendarCase, select: 'pick', count: 1 }, TZ);
    expect(pick).toBe('- 11/12(목) 12:05–13:00 예산 보고 — 중요해요.');
  });

  it('renders the empty-ranked sentence with the criteria hint, and the fallback with the listing', () => {
    expect(renderJudge({ intro: 'x', ranked: [], extra: [] }, calendarCase, TZ)).toBe(`위 내용만으로는 답하기 어려워요. ${CRITERIA_HINT.ko}`);
    const fb = renderFallback(calendarCase, TZ);
    expect(fb.startsWith('1. 11/12(목) 10:00–11:30 신제품 가격 확정 회의\n2. ')).toBe(true);
    expect(fb.endsWith(FALLBACK_HINT.ko)).toBe(true);
  });
});

describe('guards', () => {
  const good = { intro: '정리했어요.', ranked: [{ n: 2, why: '{item:1}과 겹쳐요.' }, { n: 1, why: '{time:1}에 시작해요.' }, { n: 3, why: '두 시간 여유가 있어요.' }], extra: [] };
  const raw = (o: unknown) => JSON.stringify(o);

  it('passes a valid output and reports empty ranked as not a failure', () => {
    expect(guardOutput(raw(good), calendarCase)).toMatchObject({ ok: true, empty: false });
    expect(guardOutput(raw({ intro: '', ranked: [], extra: [] }), calendarCase)).toMatchObject({ ok: true, empty: true });
  });

  it('fails each check in order', () => {
    const g = (o: unknown) => guardOutput(typeof o === 'string' ? o : raw(o), calendarCase).check;
    expect(g('Here is the answer: {}')).toBe('strict-parse');
    expect(g({ ...good, usedItems: [] })).toBe('strict-parse');
    expect(g({ ...good, ranked: [{ n: 1, why: 'a', extra: 1 }, ...good.ranked.slice(1)] })).toBe('strict-parse');
    expect(g({ ...good, ranked: [{ n: 1, why: 'a' }, { n: 1, why: 'b' }, { n: 3, why: 'c' }] })).toBe('ordinal-unique');
    expect(g({ ...good, ranked: [{ n: 1, why: 'a' }, { n: 2, why: 'b' }] })).toBe('select-shape');
    expect(g({ ...good, ranked: [{ n: 1, why: 'a' }, { n: 2, why: 'b' }, { n: 9, why: 'c' }] })).toBe('ordinal-range');
    expect(g({ ...good, extra: ['자료는 https://x.example 참고'] })).toBe('url');
    expect(g({ ...good, extra: ['legal@example.test에 회신'] })).toBe('url');
    expect(g({ ...good, extra: ['www.foo 확인'] })).toBe('url');
    expect(g({ ...good, intro: '비밀번호는 1234예요' })).toBe('credential');
    expect(g({ ...good, intro: 'ghp_abcdefghijklmnopqrstuvwx' })).toBe('credential');
    expect(g({ ...good, intro: '{title:1} 먼저' })).toBe('placeholder');
    expect(g({ ...good, intro: '10:00 회의 먼저' })).toBe('time-date');
    expect(g({ ...good, intro: 'x'.repeat(151) })).toBe('length');
    expect(g({ ...good, intro: 'a\nb\nc' })).toBe('length');
    expect(g({ ...good, extra: ['a', 'b', 'c', 'd'] })).toBe('length');
    expect(g({ ...good, ranked: [{ n: 2, why: 'a\nb' }, ...good.ranked.slice(1)] })).toBe('length');
  });

  it('rejects time placeholders outside calendar', () => {
    const jira = { source: 'jira', select: 'pick', count: 1, items: [{ key: 'A-1', summary: 'a', status: 'x' }, { key: 'A-2', summary: 'b', status: 'x' }] };
    expect(guardOutput(raw({ intro: '', ranked: [{ n: 1, why: '{time:1} 마감' }], extra: [] }), jira).check).toBe('placeholder');
    expect(guardOutput(raw({ intro: '', ranked: [{ n: 1, why: '{item:2}보다 급해요' }], extra: [] }), jira).ok).toBe(true);
  });

  it('catches model-written clock times and dates but allows relative words and durations', () => {
    for (const t of ['10:00에', '오후 3시', '3시 반', '세 시에', '열한 시', '11월 12일', '11/12', '3pm', '9:30 am', 'Nov 12', '12th of November', '2026-11-12', '12일에']) {
      expect(hasTimeOrDate(t), t).toBe(true);
    }
    for (const t of ['두 시간', '3시간 회의', '3일 뒤', '2일간', '내일 오전', '목요일', '이번 주', '시작 전에', '한 시간 여유', '세 개', '30분 겹쳐요', 'two items']) {
      expect(hasTimeOrDate(t), t).toBe(false);
    }
  });

  it('has a fixed correction for every check that can fail', () => {
    for (const check of CHECKS) expect(typeof CORRECTIONS[check]).toBe('string');
  });
});

describe('case set format', () => {
  it('accepts a valid case and rejects malformed ones', () => {
    expect(validateCase(calendarCase)).toEqual([]);
    expect(validateCase({ ...calendarCase, count: 2 }).join()).toMatch(/count is allowed only with select pick/);
    expect(validateCase({ ...calendarCase, select: 'pick', count: 11 }).join()).toMatch(/count must be an integer/);
    expect(validateCase({ ...calendarCase, items: [calendarCase.items[0]] }).join()).toMatch(/items must be an array of 2..10/);
    expect(validateCase({ ...calendarCase, items: [{ ...calendarCase.items[0], title: 'x' }, calendarCase.items[1]] }).join()).toMatch(/unknown field title/);
    expect(validateCase({ ...calendarCase, items: [cal('a', '11:00', '10:00'), calendarCase.items[1]] }).join()).toMatch(/end must be after start/);
    expect(validateCase({ ...calendarCase, now: '2026-11-11 09:00' }).join()).toMatch(/now must be/);
    expect(validateCase({ ...calendarCase, judgment: 'x' }).join()).toMatch(/unknown field judgment/);
  });

  it('checks the G6 coverage minimums', () => {
    const cov = coverage({ timezone: TZ, cases: [calendarCase] });
    expect(cov.calendarOverlapOrBackToBack).toBe(1);
    expect(cov.unmet.join('\n')).toMatch(/calendar cases 1 < 30/);
    expect(cov.unmet.join('\n')).toMatch(/no en case/);
    expect(cov.unmet.join('\n')).toMatch(/attendees\/organizer 0\/1/);
  });

  it('adapts the 2026-10-23 tuning set for the LT dry run (valid requests, no model)', () => {
    const tuning = JSON.parse(readFileSync(join(REPO, 'packages/core/src/application/golden/a2/local-judgment-cases.v1.json'), 'utf8'));
    const set = adaptTuningSet(tuning);
    expect(validateSet(set)).toEqual([]);
    expect(set.cases).toHaveLength(35);
    expect(set.cases.find((c: { id: string }) => c.id === 'lj-002').select).toBe('order');
    expect(set.cases.find((c: { id: string }) => c.id === 'lj-005')).toMatchObject({ select: 'pick', count: 2 });
    for (const c of set.cases) expect(() => buildJudgeSchema({ select: c.select, count: c.count, n: c.items.length })).not.toThrow();
  });
});

describe('fail-closed freeze', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const SET_PATH = 'packages/core/src/application/golden/a2/local-judgment-heldout.v2.json';
  function fakeRepo(): { repo: string; hashes: Record<string, string> } {
    const repo = mkdtempSync(join(tmpdir(), 'quoky-g6-'));
    dirs.push(repo);
    const hashes: Record<string, string> = {};
    for (const rel of [PROMPT_PATH, ...HARNESS_FILES, SET_PATH]) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), `content of ${rel}`);
      hashes[rel] = sha256(Buffer.from(`content of ${rel}`));
    }
    mkdirSync(dirname(join(repo, RUBRIC_PATH)), { recursive: true });
    copyFileSync(join(REPO, RUBRIC_PATH), join(repo, RUBRIC_PATH));
    return { repo, hashes };
  }
  function addendum(hashes: Record<string, string>, { withSet = true } = {}): string {
    const part1 = ['```g6-freeze', `prompt ${PROMPT_PATH} ${hashes[PROMPT_PATH]}`, ...HARNESS_FILES.map((f: string) => `harness ${f} ${hashes[f]}`), '```'];
    const part2 = ['```g6-freeze', `set ${SET_PATH} ${hashes[SET_PATH]}`, '```'];
    return ['# DECISIONS', ...part1, 'text', ...(withSet ? part2 : [])].join('\n');
  }
  /** Part 1 hashes in commit c1, the set hash in the later hash-only commit c2. */
  const gitFor = (setSha: string) => ({
    firstCommitAdding: (sha: string) => ({ commit: sha === setSha ? 'c2' : 'c1', time: 1 }),
    isAncestor: (a: string, b: string) => a === 'c1' && b === 'c2',
    changedFiles: () => ['DECISIONS.md'],
    existsInCommit: () => false,
  });
  const goodGit = gitFor('set');

  it('parses g6-freeze blocks and fails closed on a malformed line', () => {
    const { hashes } = fakeRepo();
    const entries = parseFreezeEntries(addendum(hashes));
    expect(entries.filter((e: { kind: string }) => e.kind === 'harness')).toHaveLength(HARNESS_FILES.length);
    expect(entries.filter((e: { kind: string }) => e.kind === 'set')).toHaveLength(1);
    expect(() => parseFreezeEntries('```g6-freeze\nprompt x notahash\n```')).toThrow(/malformed/);
  });

  it('holds when every hash matches, and refuses on any mismatch', () => {
    const { repo, hashes } = fakeRepo();
    const hashOf = fileHasher(repo);
    const entries = parseFreezeEntries(addendum(hashes));
    expect(checkFreeze({ entries, mode: 'g6', setPath: SET_PATH, hashOf })).toEqual([]);

    writeFileSync(join(repo, PROMPT_PATH), 'tuned after the freeze');
    expect(checkFreeze({ entries, mode: 'g6', setPath: SET_PATH, hashOf }).join()).toMatch(/prompt hash mismatch/);
    writeFileSync(join(repo, PROMPT_PATH), `content of ${PROMPT_PATH}`);

    writeFileSync(join(repo, 'tools/g6/facts.mjs'), 'changed');
    expect(checkFreeze({ entries, mode: 'g6', setPath: SET_PATH, hashOf }).join()).toMatch(/harness hash mismatch: tools\/g6\/facts.mjs/);
    writeFileSync(join(repo, 'tools/g6/facts.mjs'), 'content of tools/g6/facts.mjs');

    writeFileSync(join(repo, SET_PATH), '{"edited": true}');
    expect(checkFreeze({ entries, mode: 'g6', setPath: SET_PATH, hashOf }).join()).toMatch(/set hash mismatch/);
    rmSync(join(repo, SET_PATH));
    expect(checkFreeze({ entries, mode: 'g6', setPath: SET_PATH, hashOf }).join()).toMatch(/set file missing/);
  });

  it('refuses a missing set entry for G6, a wrong set path, and an incomplete or extra harness list', () => {
    const { repo, hashes } = fakeRepo();
    const hashOf = fileHasher(repo);
    const noSet = parseFreezeEntries(addendum(hashes, { withSet: false }));
    expect(checkFreeze({ entries: noSet, mode: 'g6', setPath: SET_PATH, hashOf }).join()).toMatch(/exactly one set entry, found 0/);
    expect(checkFreeze({ entries: noSet, mode: 'dry-run', hashOf })).toEqual([]);
    const entries = parseFreezeEntries(addendum(hashes));
    expect(checkFreeze({ entries, mode: 'g6', setPath: 'other.json', hashOf }).join()).toMatch(/is not the set being run/);
    const missing = entries.filter((e: { path: string }) => e.path !== 'tools/g6/render.mjs');
    expect(checkFreeze({ entries: missing, mode: 'g6', setPath: SET_PATH, hashOf }).join()).toMatch(/no harness entry for tools\/g6\/render.mjs/);
    const extra = [...entries, { kind: 'harness', path: 'tools/g6/other.mjs', sha256: '0'.repeat(64) }];
    expect(checkFreeze({ entries: extra, mode: 'g6', setPath: SET_PATH, hashOf }).join()).toMatch(/unexpected harness entry/);
    const twoPrompts = [...entries, { kind: 'prompt', path: PROMPT_PATH, sha256: hashes[PROMPT_PATH] }];
    expect(checkFreeze({ entries: twoPrompts, mode: 'g6', setPath: SET_PATH, hashOf }).join()).toMatch(/exactly one prompt entry/);
  });

  it('enforces the commit order: prompt and harness strictly before a hash-only set commit', () => {
    const entries = [
      { kind: 'prompt', path: PROMPT_PATH, sha256: 'p' },
      { kind: 'harness', path: HARNESS_FILES[0], sha256: 'h' },
      { kind: 'set', path: SET_PATH, sha256: 'set' },
    ];
    const now = 10;
    expect(checkCommitOrder({ entries, mode: 'g6', git: goodGit, now })).toEqual([]);
    const together = { ...goodGit, firstCommitAdding: () => ({ commit: 'c1', time: 1 }) };
    expect(checkCommitOrder({ entries, mode: 'g6', git: together, now }).join()).toMatch(/committed together with the set hash/);
    const notBefore = { ...goodGit, isAncestor: () => false };
    expect(checkCommitOrder({ entries, mode: 'g6', git: notBefore, now }).join()).toMatch(/not committed before the set hash/);
    const notHashOnly = { ...goodGit, changedFiles: () => ['DECISIONS.md', SET_PATH] };
    expect(checkCommitOrder({ entries, mode: 'g6', git: notHashOnly, now }).join()).toMatch(/not hash-only/);
    const setVisible = { ...goodGit, existsInCommit: () => true };
    expect(checkCommitOrder({ entries, mode: 'g6', git: setVisible, now }).join()).toMatch(/already existed in the prompt-hash commit/);
    const uncommitted = { ...goodGit, firstCommitAdding: () => null };
    expect(checkCommitOrder({ entries, mode: 'dry-run', git: uncommitted, now }).join()).toMatch(/not in any committed DECISIONS.md/);
    expect(checkCommitOrder({ entries, mode: 'g6', git: goodGit, now: 0 }).join()).toMatch(/not dated before the run start/);
  });

  it('checks the model manifest digest and layer', () => {
    expect(checkModelManifest(null)).toEqual(['qwen3:8b manifest file not found']);
    const fake = Buffer.from(JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:00' }] }));
    const problems = checkModelManifest(fake);
    expect(problems.join()).toMatch(/manifest sha256/);
    expect(problems.join()).toMatch(/model layer/);
  });

  it('verifyAll collects every problem (no git, no network)', () => {
    const { repo, hashes } = fakeRepo();
    const r = verifyAll({ repo, mode: 'g6', setPath: SET_PATH, now: 10, gitImpl: gitFor(hashes[SET_PATH]), manifestBytes: null, decisionsText: addendum(hashes) });
    expect(r.problems).toEqual(['qwen3:8b manifest file not found']);
    const bad = verifyAll({ repo, mode: 'g6', setPath: SET_PATH, now: 10, gitImpl: goodGit, manifestBytes: null, decisionsText: '```g6-freeze\nbogus\n```' });
    expect(bad.problems.join()).toMatch(/malformed/);
  });

  it('the repository addendum, once present, matches the files in this tree', () => {
    const entries = parseFreezeEntries(readFileSync(join(REPO, 'DECISIONS.md'), 'utf8'));
    if (entries.length === 0) return; // part 1 not committed yet
    expect(checkFreeze({ entries, mode: 'dry-run', hashOf: fileHasher(REPO) })).toEqual([]);
  });
});

describe('blind session and decision rule', () => {
  it('orders outputs by sha256(seed + caseId + arm)', () => {
    const outs = [{ caseId: 'a', arm: 'L0' }, { caseId: 'a', arm: 'LT' }, { caseId: 'b', arm: 'L0' }, { caseId: 'b', arm: 'LT' }];
    const ordered = blindOrder(outs);
    const keys = ordered.map((o: { caseId: string; arm: string }) => blindKey(o.caseId, o.arm));
    expect([...keys].sort()).toEqual(keys);
    expect(ordered[0].blindId).toBe(keys[0].slice(0, 16));
    expect(blindKey('a', 'L0')).toBe(sha256(Buffer.from('quoky-g6-20261026aL0')));
  });

  it('checks latency bars per arm', () => {
    const l0 = latencySummary('L0', [{ latencyMs: 12_000, cold: true }, { latencyMs: 3_000, cold: false }, { latencyMs: 4_000, cold: false }]);
    expect(l0).toMatchObject({ coldMs: 12_000, warmMedianMs: 3_500, meetsBar: true });
    expect(latencySummary('L0', [{ latencyMs: 16_000, cold: true }, { latencyMs: 3_000, cold: false }]).misses).toEqual(['cold']);
    const lt = Array.from({ length: 20 }, (_, i) => ({ latencyMs: i === 19 ? 40_000 : 15_000, cold: false }));
    expect(latencySummary('LT', lt)).toMatchObject({ warmP95Ms: 15_000, meetsBar: true });
    lt[18].latencyMs = 36_000;
    expect(latencySummary('LT', lt).misses).toEqual(['warm p95']);
  });

  it('chooses the arm and the calendar decision as pre-registered', () => {
    expect(decide({ L0: { meetsBar: true, calendarShare: 0.8 }, LT: { meetsBar: true, calendarShare: 0.8 } })).toMatchObject({ chosenArm: 'L0', decision: 'local-adequate' });
    expect(decide({ L0: { meetsBar: true, calendarShare: 0.7 }, LT: { meetsBar: true, calendarShare: 0.75 } })).toMatchObject({ chosenArm: 'LT', decision: 'near-miss' });
    expect(decide({ L0: { meetsBar: true, calendarShare: 0.6 }, LT: { meetsBar: false, calendarShare: 0.9 } })).toMatchObject({ chosenArm: 'L0', decision: 'local-not-adequate' });
    expect(decide({ L0: { meetsBar: false, calendarShare: 0.9 } })).toMatchObject({ chosenArm: null });
    const u = usablePlus([{ source: 'calendar', label: 'good' }, { source: 'calendar', label: 'useless' }, { source: 'mail', label: 'usable' }]);
    expect(u.calendar).toEqual({ usablePlus: 1, total: 2, share: 0.5 });
    expect(() => usablePlus([{ source: 'calendar', label: 'ok' }])).toThrow();
  });

  it('allows the LT retry only when the time left covers the p95', () => {
    expect(retryAllowed({ arm: 'L0', elapsedMs: 44_000, firstAttemptMs: [] })).toBe(true);
    expect(retryAllowed({ arm: 'L0', elapsedMs: 45_000, firstAttemptMs: [] })).toBe(false);
    expect(retryAllowed({ arm: 'LT', elapsedMs: 9_000, firstAttemptMs: [] })).toBe(true); // 36 s left ≥ 35 s bar
    expect(retryAllowed({ arm: 'LT', elapsedMs: 11_000, firstAttemptMs: [] })).toBe(false);
    expect(retryAllowed({ arm: 'LT', elapsedMs: 30_000, firstAttemptMs: [10_000, 10_000, 12_000, 14_000, 15_000] })).toBe(true);
    expect(retryAllowed({ arm: 'LT', elapsedMs: 31_000, firstAttemptMs: [10_000, 10_000, 12_000, 14_000, 15_000] })).toBe(false);
  });
});
