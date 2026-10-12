/**
 * Selection input preparation (ADR-0120 D3 input, D8). The owner's text is the only content sent to the selector, and
 * only after Core removed what the owner did not write as a request:
 *
 *  - fenced blocks (```…```) are replaced by a placeholder;
 *  - quoted lines (`> …`, the platforms' quote markup) are replaced by a placeholder;
 *  - attachments are never read here; their count becomes a placeholder line.
 *
 * Text over {@link NL_SELECTION_MAX_INPUT_CHARS} characters skips selection (a long paste is not a lookup request). The
 * prepared text is also the grounding text of D4 step 5: a keyword the selector returns must appear in it verbatim, so
 * pasted or quoted content can never ground a keyword. Pure, no clock.
 */

/** ADR-0120 D3: text over this many characters (code points) skips selection. */
export const NL_SELECTION_MAX_INPUT_CHARS = 600;

export const NL_FENCED_PLACEHOLDER = '[fenced block omitted]';
export const NL_QUOTED_PLACEHOLDER = '[quoted text omitted]';

export interface PreparedSelectionInput {
  /** The text sent to the selector (placeholders included). */
  readonly text: string;
  /** The owner's own non-quoted words (placeholders removed), for keyword grounding. */
  readonly groundingText: string;
}

export type SelectionInputSkip = 'too-long' | 'empty';

const FENCED = /```[\s\S]*?(?:```|$)/g;
const QUOTED_LINE = /^[ \t]*>.*$/gm;

/** Prepare the owner's text, or say why selection is skipped. */
export function prepareSelectionInput(
  rawText: string,
  attachmentCount = 0,
): PreparedSelectionInput | { readonly skip: SelectionInputSkip } {
  const text = rawText.normalize('NFC');
  if (Array.from(text).length > NL_SELECTION_MAX_INPUT_CHARS) return { skip: 'too-long' };
  const withPlaceholders = text
    .replace(FENCED, ` ${NL_FENCED_PLACEHOLDER} `)
    .replace(QUOTED_LINE, NL_QUOTED_PLACEHOLDER)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const groundingText = withPlaceholders
    .split(NL_FENCED_PLACEHOLDER)
    .join(' ')
    .split(NL_QUOTED_PLACEHOLDER)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (groundingText.length === 0) return { skip: 'empty' };
  const attachments =
    attachmentCount > 0 ? `\n[${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'} omitted]` : '';
  return { text: `${withPlaceholders}${attachments}`, groundingText };
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
