import { describe, expect, it } from 'vitest';
import type { ConnectorItem } from '../../ports';
import { plainTextOf } from '../message-rendering';
import {
  EXTERNAL_WORK_FOOTER_MAX_CHARS,
  buildExternalWorkReadout,
  countExternalWorkPromptItems,
  renderExternalWorkIndexFooter,
  renderExternalWorkReadoutForPrompt,
  stripLeadingListMarkers,
} from './external-work-readout';
import { releaseIssuesInDisplayOrder, renderNumberedReleaseIssues, renderReleaseIssues } from './jira-release-renderer';
import { certainlyRenderedRows, renderExternalWorkList, renderNumberedExternalWorkList } from './work-chat-renderer';

function items(count: number, make: (index: number) => Partial<ConnectorItem> = () => ({})): ConnectorItem[] {
  return Array.from({ length: count }, (_v, i) => ({
    id: `PROJ-${i + 1}`,
    title: `Task ${i + 1}`,
    url: `https://acme.atlassian.net/browse/PROJ-${i + 1}`,
    ...make(i),
  }));
}
const build = (list: ConnectorItem[], source: 'jira' | 'slack' = 'jira') => buildExternalWorkReadout({ source, query: 'my-items', items: list });
const text = (body: Parameters<typeof plainTextOf>[0]): string => plainTextOf(body);

describe('stripLeadingListMarkers (D1: the model numbering is never a label)', () => {
  it.each([
    ['1. a', '- a'],
    ['2) b', '- b'],
    ['(3) c', '- c'],
    ['4번 d', '- d'],
    ['5번: e', '- e'],
    ['- 2. f', '- f'],
    ['• 3) g', '- g'],
    ['   7. 들여쓴 줄', '- 들여쓴 줄'],
    ['１. 전각 숫자', '- 전각 숫자'],
    ['① f', '- f'],
    ['- ② g', '- g'],
  ])('%s -> %s', (input, expected) => {
    expect(stripLeadingListMarkers(input)).toBe(expected);
  });

  it.each(['두 번째 이슈', '2번째 이슈', '3번째 항목', '10.5% 증가', '2026년 계획', '- 그냥 불릿', '일반 문장입니다', '3개 남았어요'])('leaves %s untouched', (line) => {
    expect(stripLeadingListMarkers(line)).toBe(line);
  });

  it('works line by line and keeps the rest', () => {
    expect(stripLeadingListMarkers('요약입니다\n1. 첫째\n2. 둘째\n마무리')).toBe('요약입니다\n- 첫째\n- 둘째\n마무리');
  });
});

describe('buildExternalWorkReadout: itemRef', () => {
  it('keeps a well-formed itemRef and drops a malformed one', () => {
    const readout = build(
      items(4, (i) => ({ itemRef: ['PROJ-1:10001', 'C0123:1700000000.000100', 'bad ref with space', 'x'.repeat(201)][i] })),
    );
    expect(readout.items.map((item) => item.itemRef)).toEqual(['PROJ-1:10001', 'C0123:1700000000.000100', undefined, undefined]);
    expect('itemRef' in readout.items[2]!).toBe(false);
  });

  it('never carries an itemRef into the prompt', () => {
    const readout = build(items(3, (i) => ({ itemRef: `PROJ-${i + 1}:1000${i}` })));
    const prompt = renderExternalWorkReadoutForPrompt(readout);
    expect(prompt).not.toContain('itemRef');
    expect(prompt).not.toMatch(/:1000\d/);
    expect(prompt).toContain('[jira:PROJ-1]');
  });
});

describe('renderExternalWorkIndexFooter', () => {
  it('writes one numbered line per used item in readout order, including items without a URL', () => {
    const readout = build(items(3, (i) => (i === 1 ? { url: undefined } : {})));
    const { footer, labelled } = renderExternalWorkIndexFooter(readout);
    expect(labelled).toBe(3);
    expect(text(footer)).toBe(
      ['출처:', '1. Task 1 https://acme.atlassian.net/browse/PROJ-1', '2. Task 2', '3. Task 3 https://acme.atlassian.net/browse/PROJ-3', '외부 항목 3건을 요약에 사용했어요.'].join('\n'),
    );
  });

  it('keeps the disclosure line unchanged', () => {
    const readout = build([...items(2), { id: `X-1`, title: `leak ${'gh' + 'p_' + 'a'.repeat(36)}` }]);
    const out = text(renderExternalWorkIndexFooter(readout).footer);
    expect(out).toContain('외부 항목 2건을 요약에 사용했어요. 민감정보가 있는 1건은 제외했어요.');
  });

  it('stops before rows that would not fit at the worst-case rendering, and labelled equals the index lines written', () => {
    const long = '가'.repeat(60);
    const readout = build(items(10, (i) => ({ title: `${long}${i}` })));
    const { footer, labelled } = renderExternalWorkIndexFooter(readout);
    const rendered = text(footer);
    const indexLines = rendered.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(labelled).toBeGreaterThan(0);
    expect(labelled).toBeLessThan(10);
    expect(indexLines).toHaveLength(labelled);
    indexLines.forEach((line, index) => expect(line.startsWith(`${index + 1}. `)).toBe(true));
    expect(rendered.length).toBeLessThanOrEqual(EXTERNAL_WORK_FOOTER_MAX_CHARS);
    expect(rendered).toContain('외부 항목 ');
  });

  it('labelled never exceeds the used items', () => {
    const readout = build(items(5));
    expect(renderExternalWorkIndexFooter(readout).labelled).toBeLessThanOrEqual(countExternalWorkPromptItems(readout));
  });

  it('an empty readout labels nothing', () => {
    expect(renderExternalWorkIndexFooter(build([])).labelled).toBe(0);
  });
});

describe('renderNumberedExternalWorkList', () => {
  it('prefixes 1. … n. while the plain list is unchanged', () => {
    const readout = build(items(3));
    const numbered = renderNumberedExternalWorkList(readout);
    const lines = text(numbered.body).split('\n');
    expect(lines[0]).toContain('Jira');
    expect(lines.slice(1, 4).map((line) => line.slice(0, 15))).toEqual(['1. [jira:PROJ-1', '2. [jira:PROJ-2', '3. [jira:PROJ-3']);
    expect(numbered.labelled).toBe(3);
    const plain = text(renderExternalWorkList(readout));
    expect(plain).toContain('- [jira:PROJ-1] Task 1');
    expect(plain).not.toMatch(/^\d+\. \[/m);
    expect(text(numbered.body).replace(/^\d+\. \[/gm, '- [')).toBe(plain);
  });

  it('labelled is at most the number of rows and stops when rows would not certainly fit', () => {
    const readout = build(items(10, (i) => ({ title: `${'긴제목'.repeat(60)}${i}` })));
    const { body, labelled } = renderNumberedExternalWorkList(readout);
    expect(labelled).toBeGreaterThan(0);
    expect(labelled).toBeLessThan(10);
    const shown = text(body).split('\n').filter((line) => /^\d+\. \[/.test(line));
    expect(shown.length).toBeGreaterThanOrEqual(labelled);
  });

  it('an empty list labels nothing', () => {
    expect(renderNumberedExternalWorkList(build([])).labelled).toBe(0);
  });
});

describe('certainlyRenderedRows', () => {
  it('counts the droppable rows that fit at twice their plain length after the fixed lines', () => {
    const rows = Array.from({ length: 5 }, (_v, i) => ({ text: `${i}`.repeat(100), droppable: true }));
    const lines = [{ text: '헤더' }, ...rows];
    // 1800 - note - 2 - header(2*2+1) = ~1750; each row costs 201.
    expect(certainlyRenderedRows(lines)).toBe(5);
    expect(certainlyRenderedRows(lines, 600)).toBe(2);
    expect(certainlyRenderedRows(lines, 10)).toBe(0);
    expect(certainlyRenderedRows([{ text: 'fixed' }])).toBe(0);
  });
});

describe('renderNumberedReleaseIssues', () => {
  const rel = (id: string, statusCategory: ConnectorItem['statusCategory']): ConnectorItem => ({
    id,
    title: `이슈 ${id}`,
    ...(statusCategory !== undefined ? { statusCategory } : {}),
    assignee: '담당',
    status: 'S',
  });
  const mixed = [rel('A-1', 'done'), rel('A-2', 'todo'), rel('A-3', 'in-progress'), rel('A-4', 'done'), rel('A-5', undefined)];

  it('display order is to do, in progress, done... as the report groups them', () => {
    expect(releaseIssuesInDisplayOrder(mixed).map((item) => item.id)).toEqual(['A-1', 'A-4', 'A-3', 'A-2', 'A-5']);
  });

  it('numbers rows across status groups in display order and counts only issue rows', () => {
    const view = { scope: 'mine' as const, items: mixed, truncated: false, releaseName: 'v1' };
    const { body, labelled } = renderNumberedReleaseIssues(view);
    const out = text(body);
    const numbered = out.split('\n').filter((line) => /^\d+\. \[/.test(line));
    const order = releaseIssuesInDisplayOrder(mixed).map((item) => item.id);
    expect(numbered.map((line) => /^\d+/.exec(line)![0])).toEqual(['1', '2', '3', '4', '5']);
    numbered.forEach((line, index) => expect(line).toContain(`[${order[index]}]`));
    expect(labelled).toBe(5);
    expect(out).toContain('완료 (2)');
    // Headings are not numbered.
    expect(out).not.toMatch(/^\d+\. 완료/m);
  });

  it('the plain report keeps bullets', () => {
    const out = text(renderReleaseIssues({ scope: 'mine', items: mixed, truncated: false }));
    expect(out).toContain('- [A-1]');
    expect(out).not.toMatch(/^\d+\. \[/m);
  });

  it('labelled counts only rows (not headings) when the budget cuts the end', () => {
    const many = Array.from({ length: 10 }, (_v, i) => ({ ...rel(`B-${i}`, i % 2 === 0 ? 'done' : 'todo'), title: '길게'.repeat(40) }));
    const { body, labelled } = renderNumberedReleaseIssues({ scope: 'all', items: many, truncated: false });
    expect(labelled).toBeGreaterThan(0);
    expect(labelled).toBeLessThanOrEqual(10);
    const shown = text(body).split('\n').filter((line) => /^\d+\. \[/.test(line));
    expect(shown.length).toBeGreaterThanOrEqual(labelled);
  });

  it('an empty report labels nothing', () => {
    expect(renderNumberedReleaseIssues({ scope: 'mine', items: [], truncated: false }).labelled).toBe(0);
  });
});
