import { describe, expect, it } from 'vitest';
import { MAX_TABLE_COLUMNS, renderMarkdownTablesForDiscord as render } from './markdown-tables';

// ADR-0111 amendment of 2026-10-08: simple Markdown tables in a FLAGGED model reply become Discord-friendly lines;
// code (backtick and tilde fences of any length, indented code) and malformed tables are never touched.

const lines = (...l: string[]) => l.join('\n');
const TABLE = ['| 월 | 가입자 수 |', '|---|---:|', '| 1월 | 80 |', '| 2월 | 95 |'];
const RENDERED = ['**월 · 가입자 수**', '- 월: 1월, 가입자 수: 80', '- 월: 2월, 가입자 수: 95'];

describe('renderMarkdownTablesForDiscord — simple tables', () => {
  it('a table becomes a bold header line plus `- col: value` lines; the text around it is kept', () => {
    expect(render(lines('차트 요약이에요.', '', ...TABLE, '', '꾸준히 늘었어요.'))).toBe(
      lines('차트 요약이에요.', '', ...RENDERED, '', '꾸준히 늘었어요.'),
    );
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

  it('keeps CRLF line endings; an indented table (even 1-3 spaces) is left as it is', () => {
    expect(render('x\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\ny')).toBe('x\r\n**a · b**\r\n- a: 1, b: 2\r\ny');
    const indented = lines('설명', '', '  | a | b |', '  |---|---|', '  | 1 | 2 |');
    expect(render(indented)).toBe(indented);
  });

  it('two tables in one reply are both converted; text without a pipe is returned as is', () => {
    expect(render(lines(...TABLE, '', '| x | y |', '|---|---|', '| 1 | 2 |'))).toBe(lines(...RENDERED, '', '**x · y**', '- x: 1, y: 2'));
    const plain = '파이프 없는 답이에요.\n```\ncode\n```';
    expect(render(plain)).toBe(plain);
  });
});

describe('renderMarkdownTablesForDiscord — malformed tables are left exactly as they are', () => {
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
  ])('%s', (_label, text) => {
    expect(render(text)).toBe(text);
  });

  it('a malformed table is not re-scanned for a smaller table inside it', () => {
    const text = lines('| a | b | c |', '|---|---|', '| x | y |', '|---|---|', '| 1 | 2 |');
    expect(render(text)).toBe(text);
  });
});

describe('renderMarkdownTablesForDiscord — code is never touched', () => {
  it('backtick and tilde fences: tables inside stay byte-identical, tables outside are converted', () => {
    const text = lines(
      '설명이에요.',
      '```markdown',
      ...TABLE,
      '```',
      ...TABLE,
      '~~~',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '~~~',
      '끝.',
    );
    expect(render(text)).toBe(
      lines('설명이에요.', '```markdown', ...TABLE, '```', ...RENDERED, '~~~', '| a | b |', '|---|---|', '| 1 | 2 |', '~~~', '끝.'),
    );
  });

  it('fences of different lengths: a shorter or different fence inside does not close the block', () => {
    const inner = lines('````', '```', ...TABLE, '```', '~~~~', ...TABLE, '````');
    // The ```` block contains a ``` pair and a ~~~~ line: none of them closes it, so every table inside is code.
    expect(render(inner)).toBe(inner);
    // After the matching ```` the table is prose again.
    expect(render(lines(inner, ...TABLE))).toBe(lines(inner, ...RENDERED));
  });

  it('a closing fence may be longer than the opening one, never shorter; trailing text keeps it open', () => {
    expect(render(lines('```', ...TABLE, '`````', ...TABLE))).toBe(lines('```', ...TABLE, '`````', ...RENDERED));
    const shorter = lines('`````', ...TABLE, '```', ...TABLE);
    expect(render(shorter)).toBe(shorter);
    const notAClose = lines('```', ...TABLE, '``` not a close', ...TABLE);
    expect(render(notAClose)).toBe(notAClose);
  });

  it('tilde fences: a backtick line never closes them, a longer tilde line does', () => {
    const open = lines('~~~~ text', '```', ...TABLE, '~~~', ...TABLE);
    expect(render(open)).toBe(open);
    expect(render(lines('~~~', '```', ...TABLE, '~~~~~', ...TABLE))).toBe(lines('~~~', '```', ...TABLE, '~~~~~', ...RENDERED));
  });

  it('an unclosed fence runs to the end of the reply', () => {
    const text = lines(...TABLE, '', '```', ...TABLE, '', ...TABLE);
    expect(render(text)).toBe(lines(...RENDERED, '', '```', ...TABLE, '', ...TABLE));
  });

  it('an indented fence (any indentation) also protects until its matching close (when in doubt, no conversion)', () => {
    expect(render(lines('   ```', ...TABLE, '   ```', '', ...TABLE))).toBe(lines('   ```', ...TABLE, '   ```', '', ...RENDERED));
    const indentedFence = lines('    ```', ...TABLE, '', ...TABLE);
    expect(render(indentedFence)).toBe(indentedFence);
  });

  it('a backtick "fence" whose info string contains a backtick still protects (conservative)', () => {
    const text = lines('```js `x`', ...TABLE);
    expect(render(text)).toBe(text);
  });

  it('indented code (4 spaces or a tab) is never converted, and an indented row ends a table', () => {
    const indented = lines('예시 코드:', '', '    | a | b |', '    |---|---|', '    | 1 | 2 |');
    expect(render(indented)).toBe(indented);
    const tabbed = lines('\t| a | b |', '\t|---|---|', '\t| 1 | 2 |');
    expect(render(tabbed)).toBe(tabbed);
    expect(render(lines('| a | b |', '|---|---|', '| 1 | 2 |', '    | 3 | 4 |'))).toBe(lines('**a · b**', '- a: 1, b: 2', '    | 3 | 4 |'));
  });

  it('the earlier Codex P1 payload shape: only the table outside every code block is converted', () => {
    const payload = lines('```', '| 월 | 가입자 수 |', '|---|---|', '| 1월 | 80 |', '```', '~~~', '| a | b |', '|---|---|', '| 1 | 2 |', '~~~', '    | x | y |', '    |---|---|', '| 월 | 수 |', '|---|---|', '| 2월 | 95 |');
    expect(render(payload)).toBe(
      lines('```', '| 월 | 가입자 수 |', '|---|---|', '| 1월 | 80 |', '```', '~~~', '| a | b |', '|---|---|', '| 1 | 2 |', '~~~', '    | x | y |', '    |---|---|', '**월 · 수**', '- 월: 2월, 수: 95'),
    );
  });
});

describe('renderMarkdownTablesForDiscord — nested fences, quotes and lists (Codex review P2 on 08454fb)', () => {
  it.each([
    ['a backtick fence opened inside a list item', lines('- 예시:', '- ```md', ...TABLE, '  ```')],
    ['a tilde fence opened inside a list item', lines('1. 예시:', '   ~~~', ...TABLE, '   ~~~')],
    ['a fence after a nested list marker', lines('- a', '  * ```', ...TABLE, '```')],
    ['a fence inside a > quote', lines('> ```', ...TABLE, '> ```')],
    ['a fence inside a nested > > quote and list', lines('> > - ~~~~', ...TABLE, '~~~~')],
  ])('%s: nothing inside is converted', (_label, text) => {
    expect(render(text)).toBe(text);
  });

  it('a list-item fence closes only on a matching fence; a table after the close and a blank line is prose again', () => {
    const block = lines('- 예시:', '  ````md', '  ```', ...TABLE, '  ```', '  ````');
    expect(render(lines(block, '', ...TABLE))).toBe(lines(block, '', ...RENDERED));
    // Directly after the close the list item may continue: no conversion without a blank line.
    expect(render(lines(block, ...TABLE))).toBe(lines(block, ...TABLE));
  });

  it('a Discord >>> multi-line quote quotes the rest of the message: nothing after it is converted', () => {
    const text = lines(...TABLE, '', '>>> 인용이에요', ...TABLE, '', ...TABLE);
    expect(render(text)).toBe(lines(...RENDERED, '', '>>> 인용이에요', ...TABLE, '', ...TABLE));
    expect(render(lines('>>>', ...TABLE))).toBe(lines('>>>', ...TABLE));
  });

  it('a > quote line and its lazy continuation never start a table; after a blank line a table converts', () => {
    const lazy = lines('> 인용', ...TABLE);
    expect(render(lazy)).toBe(lazy);
    const quotedRows = lines('> | a | b |', '> |---|---|', '> | 1 | 2 |');
    expect(render(quotedRows)).toBe(quotedRows);
    expect(render(lines('> 인용', '', ...TABLE))).toBe(lines('> 인용', '', ...RENDERED));
  });

  it('list items and their continuations never start a table; a blank line plus an unindented line ends the list', () => {
    const lazy = lines('- 항목', ...TABLE);
    expect(render(lazy)).toBe(lazy);
    const continued = lines('1. 항목', '', '   계속', '', '   | a | b |', '   |---|---|', '   | 1 | 2 |');
    expect(render(continued)).toBe(continued);
    expect(render(lines('- 항목', '', ...TABLE))).toBe(lines('- 항목', '', ...RENDERED));
    expect(render(lines('- 항목', '', '본문이에요.', ...TABLE))).toBe(lines('- 항목', '', '본문이에요.', ...RENDERED));
  });
});
