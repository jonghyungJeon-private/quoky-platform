import type { InboundQuotedRange } from '../../domain';

/**
 * Selection input preparation (ADR-0120 D3 input, D8). The owner's text is the only content sent to the selector, and
 * only after Core removed what the owner did not write as a request:
 *
 *  - ranges the platform marked as quoted (`InboundMessage.quotedRanges`, e.g. a Telegram blockquote) become `[quoted]`;
 *  - a line starting with `>>>` quotes the rest of the message (the Discord multi-line quote): everything from it on
 *    becomes `[quoted]`;
 *  - runs of `> …` quoted lines become one `[quoted]`; fenced blocks (```…```) become `[code]`;
 *  - attachments are never read here; their count becomes one `[files: N]` line.
 *
 * Text over {@link NL_SELECTION_MAX_INPUT_CHARS} characters skips selection, before and after the placeholders (a long
 * paste is not a lookup request, and the placeholders can never grow the request past the bound). The prepared text
 * is also the grounding text of D4 step 5: a keyword the selector returns must appear in the owner's own words, so
 * pasted or quoted content can never ground a keyword. Pure, no clock.
 */

/** ADR-0120 D3: text over this many characters (code points) skips selection. */
export const NL_SELECTION_MAX_INPUT_CHARS = 600;

export const NL_FENCED_PLACEHOLDER = '[code]';
export const NL_QUOTED_PLACEHOLDER = '[quoted]';

export interface PreparedSelectionInput {
  /** The text sent to the selector (placeholders included). */
  readonly text: string;
  /** The owner's own non-quoted words (placeholders removed), for keyword grounding. */
  readonly groundingText: string;
}

export type SelectionInputSkip = 'too-long' | 'empty';

const FENCED = /```[\s\S]*?(?:```|$)/g;
const QUOTED_LINE = /^[ \t]*>.*$/gm;
const QUOTE_TO_END = /^[ \t]*>>>/m;
/** Private-use marker for a platform-quoted range while the text is rewritten (never sent). */
const RANGE_MARK = '';

/** Prepare the owner's text, or say why selection is skipped. */
export function prepareSelectionInput(
  rawText: string,
  attachmentCount = 0,
  quotedRanges: readonly InboundQuotedRange[] = [],
): PreparedSelectionInput | { readonly skip: SelectionInputSkip } {
  if (Array.from(rawText).length > NL_SELECTION_MAX_INPUT_CHARS) return { skip: 'too-long' };
  // Platform ranges are offsets into the raw text: applied before any other rewrite.
  let text = withoutRanges(rawText.replaceAll(RANGE_MARK, ' '), quotedRanges).normalize('NFC');
  const toEnd = QUOTE_TO_END.exec(text);
  if (toEnd) text = `${text.slice(0, toEnd.index)}\n${RANGE_MARK}`;
  const withPlaceholders = text
    .replace(FENCED, ` ${NL_FENCED_PLACEHOLDER} `)
    .replace(QUOTED_LINE, RANGE_MARK)
    // A run of quoted lines (or adjacent quoted ranges) is one placeholder.
    .replace(new RegExp(`${RANGE_MARK}(?:\\s*${RANGE_MARK})*`, 'g'), NL_QUOTED_PLACEHOLDER)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  const groundingText = withPlaceholders
    .split(NL_FENCED_PLACEHOLDER)
    .join(' ')
    .split(NL_QUOTED_PLACEHOLDER)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (groundingText.length === 0) return { skip: 'empty' };
  const attachments = attachmentCount > 0 ? `\n[files: ${attachmentCount}]` : '';
  const prepared = `${withPlaceholders}${attachments}`;
  if (Array.from(prepared).length > NL_SELECTION_MAX_INPUT_CHARS) return { skip: 'too-long' };
  return { text: prepared, groundingText };
}

/** `text` with every valid quoted range replaced by the range marker (overlaps merged, out-of-bounds ranges ignored). */
function withoutRanges(text: string, ranges: readonly InboundQuotedRange[]): string {
  const valid = ranges
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start)
    .map((range) => ({ start: range.start, end: Math.min(range.end, text.length) }))
    .filter((range) => range.start < text.length)
    .sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const range of valid) {
    if (range.end <= cursor) continue;
    const start = Math.max(range.start, cursor);
    out += `${text.slice(cursor, start)}\n${RANGE_MARK}\n`;
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

/** NFC, lower-case, whitespace collapsed: the form grounding and clarification replies are compared in. */
export function normalizeForMatch(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Whether `keyword` appears verbatim (case- and spacing-insensitive) in `text`. */
export function isGroundedIn(keyword: string, text: string): boolean {
  const needle = normalizeForMatch(keyword);
  return needle.length > 0 && normalizeForMatch(text).includes(needle);
}
