/**
 * Discord renders no Markdown tables: a GFM table arrives as raw `| a | b |` text. This adapts SIMPLE tables in a
 * provider-generated reply to lines Discord does render (ADR-0111 amendment of 2026-10-08). It is applied ONLY to an
 * `OutboundMessage` the runtime flagged `format: 'model-reply'`; every other message (deterministic replies, previews,
 * approval texts, connector-write previews, diffs, reminders) is delivered byte-identical.
 *
 * Code is never touched. The scan tracks, line by line and CommonMark-style:
 * - fenced code: an opening fence of 3+ backticks or 3+ tildes (indented at most 3 spaces; a backtick fence's info
 *   string may not contain a backtick) is closed only by a fence line of the SAME character and AT LEAST the same
 *   length with nothing but whitespace after it; an unclosed fence runs to the end of the text;
 * - indented code: a line indented 4+ columns (a tab advances to the next multiple of 4) is never part of a table.
 *
 * A simple table is a header row and a delimiter row with the same number of cells (1 to {@link MAX_TABLE_COLUMNS}),
 * followed by at least one data row with exactly that many cells; every row starts and ends with an unescaped `|`.
 * Anything else that looks like a table (a cell-count mismatch, no data row, no delimiter) is left exactly as it is.
 *
 * Output: a bold header line (`**h1 · h2**`, omitted when every header cell is empty) and one `- h1: v1, h2: v2` line
 * per data row (empty cells skipped, a cell under an empty header shown alone, an all-empty row dropped), keeping the
 * table's own indentation and line ending.
 */

/** Tables wider than this are left as they are (not "simple"). */
export const MAX_TABLE_COLUMNS = 8;

interface Fence {
  readonly char: '`' | '~';
  readonly length: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const TABLE_ROW = /^ {0,3}\|.*\|[ \t]*$/u;
const DELIMITER_ROW = /^ {0,3}\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/u;

function openingFence(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  if (match === null) return null;
  const marker = match[1] as string;
  const info = match[2] as string;
  const char = marker[0] as '`' | '~';
  // CommonMark: the info string of a backtick fence may not contain a backtick (that line is inline code instead).
  if (char === '`' && info.includes('`')) return null;
  return { char, length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = FENCE_CLOSE.exec(line);
  if (match === null) return false;
  const marker = match[1] as string;
  return marker[0] === fence.char && marker.length >= fence.length;
}

/** 4+ columns of leading whitespace (a tab advances to the next multiple of 4). */
function isIndentedCode(line: string): boolean {
  let column = 0;
  for (const ch of line) {
    if (ch === ' ') column += 1;
    else if (ch === '\t') column += 4 - (column % 4);
    else return false;
    if (column >= 4) return true;
  }
  return false;
}

function isTableRow(line: string): boolean {
  if (isIndentedCode(line) || !TABLE_ROW.test(line)) return false;
  // The closing pipe must not be escaped (`| a \|` is text, not a row).
  const trimmed = line.trimEnd();
  return trimmed.length >= 2 && trimmed[trimmed.length - 2] !== '\\';
}

/** The cells of a row: outer pipes removed, split on unescaped pipes, `\|` unescaped, each cell trimmed. */
function cellsOf(row: string): string[] {
  const inner = row.trim().slice(1, -1);
  return inner.split(/(?<!\\)\|/u).map((cell) => cell.replace(/\\\|/gu, '|').trim());
}

function headerLabel(cell: string): string {
  const bold = /^\*\*(.+)\*\*$/u.exec(cell);
  return bold ? (bold[1] as string).trim() : cell;
}

function renderTable(header: readonly string[], rows: readonly (readonly string[])[], indent: string): string[] {
  const labels = header.map(headerLabel);
  const out: string[] = [];
  const titled = labels.filter((label) => label !== '');
  if (titled.length > 0) out.push(`${indent}**${titled.join(' · ')}**`);
  for (const row of rows) {
    const parts = row
      .map((cell, index) => ({ label: labels[index] ?? '', cell }))
      .filter(({ cell }) => cell !== '')
      .map(({ label, cell }) => (label === '' ? cell : `${label}: ${cell}`));
    if (parts.length > 0) out.push(`${indent}- ${parts.join(', ')}`);
  }
  return out;
}

/**
 * Render the simple Markdown tables of a provider-generated reply as Discord-friendly lines; everything else — every
 * code block, malformed table and other line — is returned unchanged. See the module comment for the exact rules.
 */
export function renderMarkdownTablesForDiscord(text: string): string {
  if (!text.includes('|')) return text;
  const raw = text.split('\n');
  // Analyse each line without a trailing CR; unconverted lines are emitted verbatim (CR included).
  const lines = raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const out: string[] = [];
  let fence: Fence | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      out.push(raw[i] as string);
      i += 1;
      continue;
    }
    const opened = isIndentedCode(line) ? null : openingFence(line);
    if (opened !== null) {
      fence = opened;
      out.push(raw[i] as string);
      i += 1;
      continue;
    }
    const delimiter = lines[i + 1];
    if (isTableRow(line) && delimiter !== undefined && isTableRow(delimiter) && DELIMITER_ROW.test(delimiter)) {
      const header = cellsOf(line);
      const width = header.length;
      // The rows of this table candidate: every following table row (a blank, fenced, indented or other line ends it).
      let end = i + 2;
      while (end < lines.length && isTableRow(lines[end] as string)) end += 1;
      const rows = lines.slice(i + 2, end).map(cellsOf);
      const simple =
        width >= 1 &&
        width <= MAX_TABLE_COLUMNS &&
        cellsOf(delimiter).length === width &&
        rows.length > 0 &&
        rows.every((row) => row.length === width);
      if (simple) {
        const indent = /^ */u.exec(line)?.[0] ?? '';
        const eol = (raw[i] as string).endsWith('\r') ? '\r' : '';
        out.push(...renderTable(header, rows, indent).map((rendered) => `${rendered}${eol}`));
      } else {
        // Malformed: left exactly as it is (and not re-scanned for a smaller table inside it).
        out.push(...raw.slice(i, end));
      }
      i = end;
      continue;
    }
    out.push(raw[i] as string);
    i += 1;
  }
  return out.join('\n');
}
