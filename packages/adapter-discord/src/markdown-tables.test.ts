import { describe, expect, it } from 'vitest';
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  isTableRenderingEligible,
  renderMarkdownTablesForDiscord as render,
} from './markdown-tables';

// ADR-0111 amendment of 2026-10-08, widened by TBL-1: simple Markdown tables in a FLAGGED model reply become
// Discord-friendly lines. A quote anywhere leaves the whole reply untouched; fences must be bare and balanced, or the
// whole reply is untouched; in a balanced reply only paragraphs outside every fence are converted.

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

describe('renderMarkdownTablesForDiscord — a quote anywhere, or fences that are not provably balanced, leave the WHOLE reply untouched', () => {
  it.each([
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

  it.each([
    ['a backtick fence opened but never closed after another', lines('```', 'a', '```', '', ...TABLE, '', '```ts', 'b')],
    ['a tilde fence closed by backticks', lines('~~~', 'x', '```', '', ...TABLE)],
    ['a backtick fence closed by tildes', lines('```', 'x', '~~~', '', ...TABLE)],
    ['a closer with a different run length', lines('````', 'x', '```', '', ...TABLE)],
    ['a closer with an info string', lines('```', 'x', '```ts', '', ...TABLE)],
    ['a second opener inside an open fence', lines('```md', '```ts', 'x', '```', '', ...TABLE)],
    ['an empty fence', lines('```', '```', '', ...TABLE)],
    ['a fence holding only blank lines', lines('```', '', '```', '', ...TABLE)],
    ['a 1-space-indented fence', lines(' ```', 'x', ' ```', '', ...TABLE)],
    ['a tab-indented fence', lines('\t```', 'x', '\t```', '', ...TABLE)],
    ['an opener with a backtick in its info string', lines('```a`b', 'x', '```', '', ...TABLE)],
    ['a tilde opener with a tilde in its info string', lines('~~~ 1~2', 'x', '~~~', '', ...TABLE)],
    ['a fence marker inside a table row', lines('| a | ``` |', '|---|---|', '| 1 | 2 |', '', '```', 'x', '```')],
    ['a lone CR in a fenced reply', lines('```', 'x\ry', '```', '', ...TABLE)],
    ['a Unicode line separator in a fenced reply', lines('```', 'x\u2028y', '```', '', ...TABLE)],
    ['a quote next to a balanced fence', lines('```', 'x', '```', '', '> 인용', '', ...TABLE)],
  ])('TBL-1 conservative scan: %s', (_label, text) => {
    expect(isTableRenderingEligible(text)).toBe(false);
    expect(render(text)).toBe(text);
  });
});

describe('renderMarkdownTablesForDiscord — TBL-1: only ASCII may follow a fence run (Codex P2 on b71196d)', () => {
  const OTHER_SPACES: ReadonlyArray<readonly [string, string]> = [
    ['NBSP U+00A0', '\u00a0'],
    ['EM SPACE U+2003', '\u2003'],
    ['VT U+000B', '\u000b'],
    ['FF U+000C', '\u000c'],
    ['BOM U+FEFF', '\ufeff'],
    ['IDEOGRAPHIC SPACE U+3000', '\u3000'],
  ];

  it.each(OTHER_SPACES)('a closer followed by %s leaves the whole reply untouched', (_label, ch) => {
    for (const run of ['```', '~~~']) {
      const text = lines(run, 'code', `${run}${ch}`, '', ...TABLE);
      expect(isTableRenderingEligible(text), `${run} closer`).toBe(false);
      expect(render(text), `${run} closer`).toBe(text);
    }
  });

  it.each(OTHER_SPACES)('an opener whose info string holds %s leaves the whole reply untouched', (_label, ch) => {
    for (const run of ['```', '~~~']) {
      for (const opener of [`${run}${ch}`, `${run}ts${ch}`, `${run}${ch}ts`]) {
        const text = lines(opener, 'code', run, '', ...TABLE);
        expect(isTableRenderingEligible(text), JSON.stringify(opener)).toBe(false);
        expect(render(text), JSON.stringify(opener)).toBe(text);
      }
    }
  });

  it('a non-ASCII info string or a tab in it is refused; printable ASCII info strings and trailing ASCII spaces or tabs on a closer are accepted', () => {
    for (const opener of ['```파이썬', '```ts\t', '```é']) {
      const text = lines(opener, 'code', '```', '', ...TABLE);
      expect(render(text), opener).toBe(text);
    }
    for (const [opener, closer] of [['```ts', '``` \t '], ['```python title="a.py" {1-3}', '```\t'], ['~~~ text', '~~~  ']] as const) {
      expect(render(lines(opener, 'code', closer, '', ...TABLE)), opener).toBe(lines(opener, 'code', closer, '', ...RENDERED));
    }
  });
});

describe('renderMarkdownTablesForDiscord — TBL-1: in a balanced reply only paragraphs outside every fence convert', () => {
  // These four inputs were "a fence marker anywhere leaves the whole reply untouched" under #145; TBL-1 converts the
  // table and keeps every fence byte-identical.
  it.each([
    ['a ``` fence before the table', ['```', 'code', '```', ''], []],
    ['a ``` fence after the table', [], ['', '```ts', 'const x = 1;', '```']],
    ['a ~~~ fence before the table', ['~~~', 'x', '~~~', ''], []],
    ['a ~~~ fence after the table', [], ['', '~~~', 'x', '~~~']],
  ])('%s', (_label, before, after) => {
    const text = lines(...before, ...TABLE, ...after);
    expect(isTableRenderingEligible(text)).toBe(true);
    expect(render(text)).toBe(lines(...before, ...RENDERED, ...after));
  });

  it('a table inside a fence is never converted; the table outside it is', () => {
    const fence = ['```md', ...TABLE, '```'];
    expect(render(lines(...fence, '', ...TABLE))).toBe(lines(...fence, '', ...RENDERED));
    // A fence holding blank lines between table rows stays one fenced region.
    const spaced = ['~~~', TABLE[0], '', TABLE[1], '', ...TABLE.slice(2), '~~~'] as string[];
    expect(render(lines(...spaced, '', ...TABLE))).toBe(lines(...spaced, '', ...RENDERED));
  });

  it('a paragraph that touches a fence (no blank line between) is left as it is', () => {
    for (const text of [lines(...TABLE, '```', 'x', '```'), lines('```', 'x', '```', ...TABLE), lines('요약:', ...TABLE, '~~~', 'x', '~~~')]) {
      expect(render(text)).toBe(text);
    }
  });

  it('several fences and tables, longer runs, info strings and CRLF', () => {
    const text = lines('설명이에요.', '', '````python', 'print(1)', '````', '', ...TABLE, '', '~~~~ text', 'a | b', '~~~~', '', '| x | y |', '|---|---|', '| 1 | 2 |');
    expect(render(text)).toBe(
      lines('설명이에요.', '', '````python', 'print(1)', '````', '', ...RENDERED, '', '~~~~ text', 'a | b', '~~~~', '', '**x · y**', '- x: 1, y: 2'),
    );
    expect(render('```\r\ncode\r\n```\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n')).toBe(
      '```\r\ncode\r\n```\r\n\r\n**a · b**\r\n- a: 1, b: 2\r\n',
    );
    // A closer may carry trailing spaces.
    expect(render(lines('```', 'x', '```  ', '', ...TABLE))).toBe(lines('```', 'x', '```  ', '', ...RENDERED));
  });

  it('lists and indentation keep their rules next to a fence', () => {
    const listed = lines('```', '- a', '```', '', '- 항목', ...TABLE);
    expect(render(listed)).toBe(listed);
    expect(render(lines('```', '- a', '```', '', ...TABLE))).toBe(lines('```', '- a', '```', '', ...RENDERED));
  });
});

describe('renderMarkdownTablesForDiscord — TBL-1: a long table stays verbatim inside a code block', () => {
  const longTable = (rows: number) => ['| 번호 | 값 |', '|---|---|', ...Array.from({ length: rows }, (_, i) => `| ${i + 1} | v${i + 1} |`)];

  it(`more than ${MAX_TABLE_ROWS} data rows: the rows are kept, wrapped in a fence; ${MAX_TABLE_ROWS} rows still convert`, () => {
    const forty = longTable(40);
    expect(render(lines('요약', '', ...forty, '', '끝'))).toBe(lines('요약', '', '```', ...forty, '```', '', '끝'));
    const atLimit = render(lines(...longTable(MAX_TABLE_ROWS)));
    expect(atLimit.split('\n')).toHaveLength(MAX_TABLE_ROWS + 1);
    expect(atLimit.startsWith('**번호 · 값**\n- 번호: 1, 값: v1')).toBe(true);
  });

  it('keeps CRLF on the wrapping fence lines and wraps a long table next to a balanced fence', () => {
    const crlf = longTable(30).join('\r\n');
    expect(render(`${crlf}\r\n`)).toBe(`\`\`\`\r\n${crlf}\r\n\`\`\`\r\n`);
    const text = lines('```', 'x', '```', '', ...longTable(26));
    expect(render(text)).toBe(lines('```', 'x', '```', '', '```', ...longTable(26), '```'));
  });

  it('the wrapped output is itself left unchanged by a second pass (balanced, the table is fenced)', () => {
    const once = render(lines(...longTable(30), '', ...TABLE));
    expect(render(once)).toBe(once);
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
