/**
 * Discord renders no Markdown tables: a GFM table arrives as raw `| a | b |` text. This adapts SIMPLE tables in a
 * provider-generated reply to lines Discord does render (ADR-0111 amendment of 2026-10-08, widened by TBL-1). It is
 * applied ONLY to an `OutboundMessage` the runtime flagged `format: 'model-reply'`; every other message (deterministic
 * replies, previews, approval texts, connector-write previews, diffs, reminders) is delivered byte-identical.
 *
 * Rendering is cosmetic, so every rule errs towards leaving text exactly as it is:
 * - **Quotes: whole reply.** A reply in which ANY line starts (after optional spaces or tabs) with `>` — a quote,
 *   including Discord's `>>>` — is returned unchanged in its entirety.
 * - **Fences: balanced or nothing (TBL-1).** Every line that contains ``` or ~~~ anywhere must be a bare fence line:
 *   at column 0, a run of three or more backticks or tildes, and no other backtick or tilde on the line. Scanning from
 *   the top, such a line opens a fence; the next marker line must be its exact closer (the same run, nothing after
 *   it but spaces) with at least one non-blank line in between. Anything else — an unclosed fence, an indented or
 *   prefixed fence (`- ````, `    ````), a marker inside a line, a different marker inside an open fence, an empty
 *   fence — leaves the WHOLE reply unchanged. No parser has to agree with CommonMark or Discord on a nested case,
 *   because no nested case is converted.
 * - **Paragraphs outside every fence.** In a balanced reply a table is converted only inside a paragraph (a block of
 *   lines between blank lines outside a fence) that contains no fenced line. A paragraph that touches a fence (no blank
 *   line between them) is left as it is, and nothing inside a fence is ever converted.
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
 * table's line ending. A simple table with more than {@link MAX_TABLE_ROWS} data rows is not converted: its lines are
 * kept verbatim inside a ``` block (one line per row stays readable; the delivery chunker splits fenced text safely).
 */

/** Tables wider than this are left as they are (not "simple"). */
export const MAX_TABLE_COLUMNS = 8;
/** Tables with more data rows than this are kept verbatim inside a ``` block instead of being converted. */
export const MAX_TABLE_ROWS = 25;

/** What the previous line leaves open: whether a table may start on the next line. */
type Context = 'start' | 'blank' | 'plain' | 'list';

/** A fence marker anywhere in a line. */
const FENCE_MARKER = /```|~~~/u;
/** The only accepted fence line: column 0, a backtick or tilde run, and no other backtick or tilde on the line. */
const BARE_FENCE_LINE = /^(`{3,}|~{3,})([^`~]*)$/u;
/** A quote line (`>`, `>>>`) anywhere in the reply makes the whole reply ineligible. */
const QUOTE_LINE = /^[ \t]*>/mu;
/** A line break other than `\n` / `\r\n` (a lone CR, NEL, LS, PS): a fenced reply holding one is never converted. */
const OTHER_LINE_BREAK = /\r(?!\n)|[\u0085\u2028\u2029]/u;
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

/**
 * Which lines lie inside a fence (opener and closer included), or `null` when the reply's fences are not provably
 * balanced (see the module rules). `lines` carry no trailing CR.
 */
function fencedLines(lines: readonly string[]): boolean[] | null {
  const fenced = lines.map(() => false);
  let open: { run: string; hasContent: boolean } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const marker = FENCE_MARKER.test(line);
    if (open !== null) {
      fenced[i] = true;
      if (!marker) {
        if (!isBlank(line)) open.hasContent = true;
        continue;
      }
      // Inside a fence the only marker line accepted is its exact closer.
      const closer = BARE_FENCE_LINE.exec(line);
      if (closer === null || closer[1] !== open.run || (closer[2] as string).trim() !== '' || !open.hasContent) return null;
      open = null;
      continue;
    }
    if (!marker) continue;
    const opener = BARE_FENCE_LINE.exec(line);
    if (opener === null) return null;
    open = { run: opener[1] as string, hasContent: false };
    fenced[i] = true;
  }
  return open === null ? fenced : null;
}

/**
 * Per line: whether it sits in a paragraph that may hold a converted table — a block between unfenced blank lines
 * that contains no fenced line. `null` when the reply is not eligible at all (a quote line, or fences that are not
 * provably balanced). A reply without any fence marker keeps the original whole-reply rule: every line may convert.
 */
function convertibleLines(text: string, lines: readonly string[]): boolean[] | null {
  if (QUOTE_LINE.test(text)) return null;
  if (!FENCE_MARKER.test(text)) return lines.map(() => true);
  if (OTHER_LINE_BREAK.test(text)) return null;
  const fenced = fencedLines(lines);
  if (fenced === null) return null;
  const convertible = lines.map(() => false);
  const separates = (i: number) => isBlank(lines[i] as string) && !fenced[i];
  let i = 0;
  while (i < lines.length) {
    if (separates(i)) {
      i += 1;
      continue;
    }
    let end = i;
    let clean = true;
    while (end < lines.length && !separates(end)) {
      if (fenced[end]) clean = false;
      end += 1;
    }
    for (let k = i; k < end; k += 1) convertible[k] = clean;
    i = end;
  }
  return convertible;
}

/** CR-free lines of a reply (unconverted lines are always emitted from the raw split, CR included). */
function analysedLines(text: string): string[] {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * Whether any part of the reply may be converted: no quote line, and every fence balanced and bare (TBL-1). An
 * eligible reply still converts only the tables in paragraphs outside every fence.
 */
export function isTableRenderingEligible(text: string): boolean {
  return convertibleLines(text, analysedLines(text)) !== null;
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
 * Render the simple Markdown tables of a provider-generated reply as Discord-friendly lines, only in paragraphs outside
 * every fence of an eligible reply; an ineligible reply (a quote line, unbalanced or non-bare fences) and every fenced
 * line, list, malformed table and other line are returned unchanged.
 */
export function renderMarkdownTablesForDiscord(text: string): string {
  if (!text.includes('|')) return text;
  const raw = text.split('\n');
  // Analyse each line without a trailing CR; unconverted lines are emitted verbatim (CR included).
  const lines = analysedLines(text);
  const convertible = convertibleLines(text, lines);
  if (convertible === null) return text;
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
      if (
        convertible[i] === true &&
        isTableRow(line) &&
        delimiter !== undefined &&
        isTableRow(delimiter) &&
        DELIMITER_ROW.test(delimiter)
      ) {
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
        if (simple && rows.length > MAX_TABLE_ROWS) {
          // Too long to convert: the table stays verbatim, inside a code block.
          const eol = (raw[i] as string).endsWith('\r') ? '\r' : '';
          out.push(`\`\`\`${eol}`, ...raw.slice(i, end), `\`\`\`${(raw[end - 1] as string).endsWith('\r') ? '\r' : ''}`);
        } else if (simple) {
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
