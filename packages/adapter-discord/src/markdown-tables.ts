/**
 * Discord renders no Markdown tables: a GFM table arrives as raw `| a | b |` text. This adapts SIMPLE tables in a
 * provider-generated reply to lines Discord does render (ADR-0111 amendment of 2026-10-08). It is applied ONLY to an
 * `OutboundMessage` the runtime flagged `format: 'model-reply'`; every other message (deterministic replies, previews,
 * approval texts, connector-write previews, diffs, reminders) is delivered byte-identical.
 *
 * The rule is deliberately the simplest provably safe one (Codex re-review P2 on 2be8ccc: tracking fences nested in
 * lists and quotes was not reliable). Rendering is cosmetic, so:
 * - **Whole-reply eligibility.** A reply in which ANY line contains ``` or ~~~ anywhere, or ANY line starts (after
 *   optional spaces or tabs) with `>` — a quote, including Discord's `>>>` — is returned unchanged in its entirety. No
 *   code fence is ever parsed, so nothing inside code can be converted.
 * - **Lists.** A list item line (`-`, `*`, `+`, `1.`, `1)`), its lazy continuation lines and any indented line never
 *   start a table; a list ends only at a blank line followed by an unindented non-list line.
 * - **Tables** start only at column 0, at the start of the reply or after a blank line or a plain paragraph line.
 *
 * A simple table is a header row and a delimiter row with the same number of cells (1 to {@link MAX_TABLE_COLUMNS}),
 * followed by at least one data row with exactly that many cells; every row starts at column 0 and starts and ends with
 * an unescaped `|`. Anything else that looks like a table is left exactly as it is.
 *
 * Output: a bold header line (`**h1 · h2**`, omitted when every header cell is empty) and one `- h1: v1, h2: v2` line
 * per data row (empty cells skipped, a cell under an empty header shown alone, an all-empty row dropped), keeping the
 * table's line ending.
 */

/** Tables wider than this are left as they are (not "simple"). */
export const MAX_TABLE_COLUMNS = 8;

/** What the previous line leaves open: whether a table may start on the next line. */
type Context = 'start' | 'blank' | 'plain' | 'list';

/** A fence marker anywhere in the reply makes the whole reply ineligible. */
const FENCE_MARKER = /```|~~~/u;
/** A quote line (`>`, `>>>`) anywhere in the reply makes the whole reply ineligible. */
const QUOTE_LINE = /^[ \t]*>/mu;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/u;
const TABLE_ROW = /^\|.*\|[ \t]*$/u;
const DELIMITER_ROW = /^\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/u;

const isBlank = (line: string): boolean => line.trim() === '';
const isIndented = (line: string): boolean => /^[ \t]/u.test(line);

function isTableRow(line: string): boolean {
  if (!TABLE_ROW.test(line)) return false;
  // The closing pipe must not be escaped (`| a \|` is text, not a row).
  const trimmed = line.trimEnd();
  return trimmed.length >= 2 && trimmed[trimmed.length - 2] !== '\\';
}

/** Whether the reply may be converted at all: no fence marker anywhere and no quote line. */
export function isTableRenderingEligible(text: string): boolean {
  return !FENCE_MARKER.test(text) && !QUOTE_LINE.test(text);
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

function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const labels = header.map(headerLabel);
  const out: string[] = [];
  const titled = labels.filter((label) => label !== '');
  if (titled.length > 0) out.push(`**${titled.join(' · ')}**`);
  for (const row of rows) {
    const parts = row
      .map((cell, index) => ({ label: labels[index] ?? '', cell }))
      .filter(({ cell }) => cell !== '')
      .map(({ label, cell }) => (label === '' ? cell : `${label}: ${cell}`));
    if (parts.length > 0) out.push(`- ${parts.join(', ')}`);
  }
  return out;
}

/**
 * Render the simple Markdown tables of an ELIGIBLE provider-generated reply as Discord-friendly lines; an ineligible
 * reply (any fence marker or quote line) and every list, malformed table and other line are returned unchanged.
 */
export function renderMarkdownTablesForDiscord(text: string): string {
  if (!text.includes('|') || !isTableRenderingEligible(text)) return text;
  const raw = text.split('\n');
  // Analyse each line without a trailing CR; unconverted lines are emitted verbatim (CR included).
  const lines = raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const out: string[] = [];
  let context: Context = 'start';
  /** A list item was seen and no blank line followed by an unindented non-list line has ended the list yet. */
  let listOpen = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      context = 'blank';
    } else if (LIST_ITEM.test(line)) {
      context = 'list';
      listOpen = true;
    } else if (context === 'list') {
      // A lazy continuation of the list item above (no blank line in between).
    } else if (isIndented(line)) {
      // Indented: a list continuation after a blank line, or indented code; never a table.
      context = listOpen ? 'list' : 'plain';
    } else {
      if (context === 'blank') listOpen = false;
      const delimiter = lines[i + 1];
      if (isTableRow(line) && delimiter !== undefined && isTableRow(delimiter) && DELIMITER_ROW.test(delimiter)) {
        const header = cellsOf(line);
        const width = header.length;
        // The rows of this table candidate: every following column-0 table row (anything else ends it).
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
          const eol = (raw[i] as string).endsWith('\r') ? '\r' : '';
          out.push(...renderTable(header, rows).map((rendered) => `${rendered}${eol}`));
        } else {
          // Malformed: left exactly as it is (and not re-scanned for a smaller table inside it).
          out.push(...raw.slice(i, end));
        }
        context = 'plain';
        i = end;
        continue;
      }
      context = 'plain';
    }
    out.push(raw[i] as string);
    i += 1;
  }
  return out.join('\n');
}
