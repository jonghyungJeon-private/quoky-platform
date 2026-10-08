import { describe, expect, it } from 'vitest';
import { MAX_TABLE_COLUMNS, isTableRenderingEligible, renderMarkdownTablesForDiscord as render } from './markdown-tables';

// ADR-0111 amendment of 2026-10-08 (whole-reply rule after Codex re-review P2 on 2be8ccc): simple Markdown tables in a
// FLAGGED model reply become Discord-friendly lines, but only when the reply has no fence marker and no quote at all.

const lines = (...l: string[]) => l.join('\n');
const TABLE = ['| 월 | 가입자 수 |', '|---|---:|', '| 1월 | 80 |', '| 2월 | 95 |'];
const RENDERED = ['**월 · 가입자 수**', '- 월: 1월, 가입자 수: 80', '- 월: 2월, 가입자 수: 95'];

describe('renderMarkdownTablesForDiscord — a plain reply with simple tables is converted', () => {
  it('a table becomes a bold header line plus `- col: value` lines; the text around it is kept', () => {
    expect(render(lines('차트 요약이에요.', '', ...TABLE, '', '꾸준히 늘었어요.'))).toBe(
      lines('차트 요약이에요.', '', ...RENDERED, '', '꾸준히 늘었어요.'),
    );
    // Directly after a plain paragraph line, too.
    expect(render(lines('요약:', ...TABLE))).toBe(lines('요약:', ...RENDERED));
  });

  it('wider tables, alignment colons, escaped pipes, bold headers and empty cells', () => {
    expect(render(lines('| **월** | 가입 | 해지 |', '| :-- | :-: | --: |', '| 1월 | 80 | 3 |', '| 2월 | a\\|b |  |', '|  |  |  |'))).toBe(
      lines('**월 · 가입 · 해지**', '- 월: 1월, 가입: 80, 해지: 3', '- 월: 2월, 가입: a|b'),
    );
  });

  it('an empty header cell shows the value alone; an all-empty header has no title line', () => {
    expect(render(lines('|  | 값 |', '|---|---|', '| a | 1 |'))).toBe(lines('**값**', '- a, 값: 1'));
    expect(render(lines('|  |  |', '|---|---|', '| a | 1 |'))).toBe('- a, 1');
  });

  it('keeps CRLF line endings; two tables are both converted; text without a pipe is returned as is', () => {
    expect(render('x\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\ny')).toBe('x\r\n**a · b**\r\n- a: 1, b: 2\r\ny');
    expect(render(lines(...TABLE, '', '| x | y |', '|---|---|', '| 1 | 2 |'))).toBe(lines(...RENDERED, '', '**x · y**', '- x: 1, y: 2'));
    expect(render('파이프 없는 답이에요.')).toBe('파이프 없는 답이에요.');
  });
});

describe('renderMarkdownTablesForDiscord — a fence marker or a quote anywhere leaves the WHOLE reply untouched', () => {
  it.each([
    ['a ``` fence before the table', lines('```', 'code', '```', '', ...TABLE)],
    ['a ``` fence after the table', lines(...TABLE, '', '```ts', 'const x = 1;', '```')],
    ['a ~~~ fence before the table', lines('~~~', 'x', '~~~', '', ...TABLE)],
    ['a ~~~ fence after the table', lines(...TABLE, '', '~~~', 'x', '~~~')],
    ['an unclosed fence', lines(...TABLE, '', '```')],
    ['a fence marker in the middle of a line', lines('인라인 ```코드``` 예시', '', ...TABLE)],
    ['a tilde run in the middle of a line', lines('범위 1~~~3', '', ...TABLE)],
    ['a > quote line', lines('> 인용', '', ...TABLE)],
    ['an indented > quote line after the table', lines(...TABLE, '', '  > 인용')],
    ['a Discord >>> quote', lines(...TABLE, '', '>>> 인용이에요')],
  ])('%s', (_label, text) => {
    expect(isTableRenderingEligible(text)).toBe(false);
    expect(render(text)).toBe(text);
  });

  it('a plain reply is eligible', () => {
    expect(isTableRenderingEligible(lines('요약', ...TABLE, '1 > 0 이에요'))).toBe(true);
  });
});

describe('renderMarkdownTablesForDiscord — every Codex review repro is unchanged', () => {
  it.each([
    // Codex P1 on df66418 (the connector-write payload shape).
    ['nested backtick, tilde and indented fences with tables', lines('```', '| 월 | 가입자 수 |', '|---|---|', '| 1월 | 80 |', '```', '~~~', '| a | b |', '|---|---|', '| 1 | 2 |', '~~~', '    | x | y |', '    |---|---|', '| 월 | 수 |', '|---|---|', '| 2월 | 95 |')],
    // Codex P2 on 08454fb.
    ['a fence opened inside a list item', lines('- 예시:', '- ```md', ...TABLE, '  ```', '', ...TABLE)],
    ['a tilde fence inside a numbered item', lines('1. 예시:', '   ~~~', ...TABLE, '   ~~~', '', ...TABLE)],
    ['a >>> multi-line quote', lines('>>> 인용', ...TABLE, '', ...TABLE)],
    ['a fence inside a > quote', lines('> ```', ...TABLE, '> ```', '', ...TABLE)],
    // Codex re-review P2 on 2be8ccc: prefixed fence lines inside an ordinary fence.
    ['`- ```` inside a ```md block', lines('```md', '- ```', ...TABLE, '```', '', ...TABLE)],
    ['`> ```` inside a ```md block', lines('```md', '> ```', ...TABLE, '```', '', ...TABLE)],
    ['`1. ~~~` inside a tilde fence', lines('~~~', '1. ~~~', ...TABLE, '~~~', '', ...TABLE)],
    ['a 4-space-indented backtick fence', lines('    ```', ...TABLE, '    ```', '', ...TABLE)],
  ])('%s', (_label, text) => {
    expect(render(text)).toBe(text);
  });
});

describe('renderMarkdownTablesForDiscord — lists, indentation and malformed tables (eligible replies)', () => {
  it('list items and their continuations never start a table; a blank line plus an unindented line ends the list', () => {
    const lazy = lines('- 항목', ...TABLE);
    expect(render(lazy)).toBe(lazy);
    const continued = lines('1. 항목', '', '   계속', '', '   | a | b |', '   |---|---|', '   | 1 | 2 |');
    expect(render(continued)).toBe(continued);
    expect(render(lines('- 항목', '', ...TABLE))).toBe(lines('- 항목', '', ...RENDERED));
    expect(render(lines('- 항목', '', '본문이에요.', ...TABLE))).toBe(lines('- 항목', '', '본문이에요.', ...RENDERED));
  });

  it('an indented table (spaces or a tab) is left as it is, and an indented row ends a table', () => {
    for (const text of [lines('설명', '', '  | a | b |', '  |---|---|', '  | 1 | 2 |'), lines('\t| a | b |', '\t|---|---|', '\t| 1 | 2 |')]) {
      expect(render(text)).toBe(text);
    }
    expect(render(lines('| a | b |', '|---|---|', '| 1 | 2 |', '    | 3 | 4 |'))).toBe(lines('**a · b**', '- a: 1, b: 2', '    | 3 | 4 |'));
  });

  it.each([
    ['no delimiter row', lines('| a | b |', '| 1 | 2 |')],
    ['header only', lines('| a | b |', '|---|---|')],
    ['delimiter cell count differs', lines('| a | b |', '|---|', '| 1 | 2 |')],
    ['a data row with another cell count', lines('| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 | 5 |')],
    ['pipes inside inline code split a cell', lines('| cmd | 설명 |', '|---|---|', '| `a|b` | 파이프 |')],
    ['rows without outer pipes', lines('a | b', '--|--', '1 | 2')],
    ['an escaped closing pipe', lines('| a | b \\|', '|---|---|', '| 1 | 2 |')],
    ['too wide', lines(`|${' c |'.repeat(MAX_TABLE_COLUMNS + 1)}`, `|${'---|'.repeat(MAX_TABLE_COLUMNS + 1)}`, `|${' 1 |'.repeat(MAX_TABLE_COLUMNS + 1)}`)],
    ['a lone pipe expression', 'a || b'],
    ['a malformed table is not re-scanned for a smaller table inside it', lines('| a | b | c |', '|---|---|', '| x | y |', '|---|---|', '| 1 | 2 |')],
  ])('malformed: %s', (_label, text) => {
    expect(render(text)).toBe(text);
  });
});
