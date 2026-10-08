/**
 * Discord renders no Markdown tables: a GFM table arrives as raw `| a | b |` text. This adapts SIMPLE tables in a
 * provider-generated reply to lines Discord does render (ADR-0111 amendment of 2026-10-08). It is applied ONLY to an
 * `OutboundMessage` the runtime flagged `format: 'model-reply'`; every other message (deterministic replies, previews,
 * approval texts, connector-write previews, diffs, reminders) is delivered byte-identical.
 *
 * When in doubt it does not convert (Codex review P2 on 08454fb). Line by line:
 * - **Protected code.** A line whose content — after any indentation, `>` quote markers and list markers (`-`, `*`, `+`,
 *   `1.`, `1)`) — starts with 3+ backticks or 3+ tildes opens a protected region (a fence nested in a list item or a
 *   quote counts, and so does a 4-space-indented one). It ends only at a line whose content, after the same prefixes, is
 *   a fence of the SAME character and AT LEAST the opening length with nothing but whitespace after it; an unclosed
 *   region runs to the end of the text. Nothing inside is converted.
 * - **Quotes.** A Discord `>>>` multi-line quote quotes everything after it: nothing from there on is converted. A `>`
 *   quote line, and any line that lazily continues it, never starts a table.
 * - **Lists.** A list item line, its continuation lines (lazy or indented), and indented lines after a blank line inside
 *   a list never start a table; a list ends only at a blank line followed by an unindented non-list line.
 * - **Tables** start only at column 0, at the start of the text or after a blank line or a plain paragraph line.
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

interface Fence {
  readonly char: '`' | '~';
  readonly length: number;
}

/** What the previous line leaves open: whether a table may start on the next line. */
type Context = 'start' | 'blank' | 'plain' | 'list' | 'quote';

const FENCE_OPEN = /^(`{3,}|~{3,})/u;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/u;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/u;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/u;
const QUOTE_LINE = /^[ \t]*>/u;
const MULTILINE_QUOTE = /^[ \t]*>>>/u;
const TABLE_ROW = /^\|.*\|[ \t]*$/u;
const DELIMITER_ROW = /^\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/u;

/** The line's content after any indentation, `>` quote markers and list markers (in any nesting order). */
function containerContent(line: string): string {
  let rest = line;
  for (;;) {
    const trimmed = rest.replace(/^[ \t]+/u, '');
    if (trimmed.startsWith('>')) {
      rest = trimmed.slice(1);
      continue;
    }
    const marker = LIST_MARKER.exec(trimmed);
    if (marker !== null) {
      rest = trimmed.slice(marker[0].length);
      continue;
    }
    return trimmed;
  }
}

function openingFence(line: string): Fence | null {
  const match = FENCE_OPEN.exec(containerContent(line));
  if (match === null) return null;
  const marker = match[1] as string;
  return { char: marker[0] as '`' | '~', length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = FENCE_CLOSE.exec(containerContent(line));
  if (match === null) return false;
  const marker = match[1] as string;
  return marker[0] === fence.char && marker.length >= fence.length;
}

const isBlank = (line: string): boolean => line.trim() === '';
const isIndented = (line: string): boolean => /^[ \t]/u.test(line);

function isTableRow(line: string): boolean {
  if (!TABLE_ROW.test(line)) return false;
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
 * Render the simple Markdown tables of a provider-generated reply as Discord-friendly lines; everything else — every
 * protected code region, quote, list, malformed table and other line — is returned unchanged. See the module comment.
 */
export function renderMarkdownTablesForDiscord(text: string): string {
  if (!text.includes('|')) return text;
  const raw = text.split('\n');
  // Analyse each line without a trailing CR; unconverted lines are emitted verbatim (CR included).
  const lines = raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const out: string[] = [];
  let fence: { readonly open: Fence; readonly context: Context } | null = null;
  let context: Context = 'start';
  /** A list item was seen and no blank line followed by an unindented non-list line has ended the list yet. */
  let listOpen = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (fence !== null) {
      if (closesFence(line, fence.open)) {
        // Back in whatever held the fence (a list item or a quote keeps tables off until a blank line).
        context = fence.context === 'list' || fence.context === 'quote' ? fence.context : 'plain';
        fence = null;
      }
      out.push(raw[i] as string);
      i += 1;
      continue;
    }
    if (MULTILINE_QUOTE.test(line)) {
      // Discord `>>>`: everything from here to the end is one quote.
      out.push(...raw.slice(i));
      break;
    }
    const opened = openingFence(line);
    if (opened !== null) {
      const holder: Context =
        QUOTE_LINE.test(line) || context === 'quote' ? 'quote' : LIST_ITEM.test(line) || listOpen ? 'list' : 'plain';
      if (holder === 'list') listOpen = true;
      fence = { open: opened, context: holder };
      out.push(raw[i] as string);
      i += 1;
      continue;
    }
    if (isBlank(line)) {
      context = 'blank';
      out.push(raw[i] as string);
      i += 1;
      continue;
    }
    if (QUOTE_LINE.test(line)) {
      context = 'quote';
    } else if (LIST_ITEM.test(line)) {
      context = 'list';
      listOpen = true;
    } else if (context === 'list' || context === 'quote') {
      // A lazy continuation of the list item or quote above (no blank line in between).
    } else if (isIndented(line)) {
      // Indented after a blank line: list continuation (or indented code); never a table.
      context = listOpen ? 'list' : 'plain';
    } else {
      if (context === 'blank') listOpen = false;
      const delimiter = lines[i + 1];
      const canStart = context === 'start' || context === 'blank' || context === 'plain';
      if (canStart && isTableRow(line) && delimiter !== undefined && isTableRow(delimiter) && DELIMITER_ROW.test(delimiter)) {
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
