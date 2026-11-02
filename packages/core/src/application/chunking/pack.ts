import { graphemeRanges } from './boundaries';
import { CodePointIndex, codePointLength } from './code-points';
import { estimateTokens } from './token-estimate';
import type { Passage, Window, WindowBudget } from './types';
import { UNTRUSTED_DOCUMENT_BODY_MAX_CHARS } from '../untrusted-document-readout';

/**
 * ADR-0124 section 3.2: a window holds at most today's readout bound in code points and 1,800 estimated tokens. The
 * code-point bound is hard; the token bound only decides when to start the next window.
 */
export const DEFAULT_WINDOW_BUDGET: WindowBudget = { maxCodePoints: UNTRUSTED_DOCUMENT_BODY_MAX_CHARS, maxEstTokens: 1_800 };
/** Between two non-adjacent pieces of one section. */
export const WINDOW_GAP_MARKER = '[...]';

interface Piece {
  readonly separator: string;
  readonly lead: string;
  readonly text: string;
}

function piece(index: CodePointIndex, passage: Passage, previous: Passage | undefined): Piece {
  const text = index.slice(passage.span.start, passage.span.end);
  const lead: string[] = [];
  let separator = '';
  const adjacent = previous !== undefined && previous.span.end === passage.span.start && previous.frame === passage.frame;
  const newFrame = passage.frame !== '' && (previous === undefined || previous.frame !== passage.frame);
  if (previous !== undefined && previous.frame !== passage.frame) separator = '\n\n';
  if (newFrame) lead.push(passage.frame);
  else if (previous !== undefined && !adjacent) {
    separator = '\n';
    lead.push(WINDOW_GAP_MARKER);
  }
  if (!adjacent) {
    const header = passage.rows?.headerSpan;
    if (header !== undefined) lead.push(index.slice(header.start, header.end).trimEnd());
    else if (passage.overlap !== undefined) lead.push(index.slice(passage.overlap.start, passage.overlap.end).trimEnd());
  }
  return { separator, lead: lead.length === 0 ? '' : `${lead.join('\n')}\n`, text };
}

/** Cuts a text to `max` code points on a grapheme boundary. */
function clipToBound(text: string, max: number): string {
  const index = new CodePointIndex(text);
  if (index.length <= max) return text;
  const [first] = graphemeRanges(text, { start: 0, end: text.length }, { maxCodePoints: max, maxTokens: Infinity }, index);
  return first === undefined ? '' : text.slice(first.start, first.end);
}

/**
 * Packs the selected passages, in document order, into windows. `prepared` is the item the passages were cut from.
 * A window starts each new section with its frame, repeats a sheet's header row when its rows are not adjacent to the
 * previous piece, and marks a skipped stretch with {@link WINDOW_GAP_MARKER}. When the selection is the whole item and
 * it fits one window, the window's text is exactly the prepared text (with a section's frame line before its body).
 */
export function packWindows(
  prepared: string,
  passages: readonly Passage[],
  selected: readonly number[],
  budget: WindowBudget = DEFAULT_WINDOW_BUDGET,
): Window[] {
  const index = new CodePointIndex(prepared);
  const wanted = [...new Set(selected)].filter((ordinal) => Number.isInteger(ordinal) && ordinal >= 0 && ordinal < passages.length).sort((a, b) => a - b);
  const windows: Window[] = [];
  let text = '';
  let ordinals: number[] = [];
  let previous: Passage | undefined;
  const close = (): void => {
    if (ordinals.length > 0) {
      const finished = text.trimEnd();
      windows.push({ text: finished, ordinals, codePoints: codePointLength(finished), estTokens: estimateTokens(finished) });
    }
    text = '';
    ordinals = [];
    previous = undefined;
  };
  for (const ordinal of wanted) {
    const passage = passages[ordinal];
    if (passage === undefined) continue;
    let next = piece(index, passage, previous);
    let candidate = ordinals.length === 0 ? `${next.lead}${next.text}` : `${text.trimEnd()}${next.separator}${next.lead}${next.text}`;
    const over = (value: string): boolean => {
      const trimmed = value.trimEnd();
      return codePointLength(trimmed) > budget.maxCodePoints || estimateTokens(trimmed) > budget.maxEstTokens;
    };
    if (ordinals.length > 0 && over(candidate)) {
      close();
      next = piece(index, passage, undefined);
      candidate = `${next.lead}${next.text}`;
    }
    if (ordinals.length === 0 && codePointLength(candidate.trimEnd()) > budget.maxCodePoints) {
      // A single piece over the hard bound: drop the carried context, then cut on a grapheme boundary.
      const bare = next.text;
      candidate = codePointLength(bare.trimEnd()) <= budget.maxCodePoints ? bare : clipToBound(bare, budget.maxCodePoints);
    }
    text = candidate;
    ordinals.push(ordinal);
    previous = passage;
  }
  close();
  return windows;
}

/** The one window of an item that fits (today's readout, by the code-point bound only), or `undefined`. */
export function singleWindow(prepared: string, passages: readonly Passage[], budget: WindowBudget = DEFAULT_WINDOW_BUDGET): Window | undefined {
  const all = passages.map((passage) => passage.ordinal);
  const windows = packWindows(prepared, passages, all, { maxCodePoints: budget.maxCodePoints, maxEstTokens: Infinity });
  return windows.length === 1 ? windows[0] : undefined;
}

function evenly(count: number, picks: number): number[] {
  if (picks >= count) return Array.from({ length: count }, (_, at) => at);
  if (picks <= 1) return [0];
  const out = new Set<number>();
  for (let step = 0; step < picks; step += 1) out.add(Math.round((step * (count - 1)) / (picks - 1)));
  return [...out].sort((a, b) => a - b);
}

/**
 * ADR-0124 section 3.6, S3 beyond the window cap: stratified coverage (the first, the last and evenly spaced in
 * between), chosen by POSITION ONLY. It never reads a score or the content of a passage (RQ-2 invariant I2). Returns
 * the sorted ordinals of the largest evenly spaced selection that packs into at most `maxWindows` windows.
 */
export function selectStratified(
  prepared: string,
  passages: readonly Passage[],
  maxWindows: number,
  budget: WindowBudget = DEFAULT_WINDOW_BUDGET,
): number[] {
  const count = passages.length;
  if (count === 0 || maxWindows < 1) return [];
  const fits = (picks: number[]): boolean => packWindows(prepared, passages, picks, budget).length <= maxWindows;
  const everything = evenly(count, count);
  if (fits(everything)) return everything;
  let best: number[] = [0];
  let low = 1;
  let high = count - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const picks = evenly(count, middle);
    if (fits(picks)) {
      best = picks;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}
