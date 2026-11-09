import { memoryPassageStartOffset } from './memory-passages';

/**
 * ADR-0124 phase 2 P2-6: how a recalled memory's content is cut for the prompt.
 *
 * - `V0`: the head, 400 code units (the original behaviour, kept byte-identical).
 * - `V1`: when the matched passage of a multi-passage memory is known, 400 code points starting at that passage.
 * - `V2`: V1, but the first three delivered entries get up to one full passage (1,200 code points).
 */
export type RecallExcerptVariant = 'V0' | 'V1' | 'V2';

export const RECALL_EXCERPT_DEFAULT_CHARS = 400;
export const RECALL_EXCERPT_TOP_RANK_CHARS = 1_200;
export const RECALL_EXCERPT_TOP_RANKS = 3;
const ELLIPSIS = '…';

/** First `max` code points of `text` from the UTF-16 offset `from`, plus whether anything was left over. */
function codePointSlice(text: string, from: number, max: number): { text: string; cut: boolean } {
  let at = from;
  let taken = 0;
  while (at < text.length && taken < max) {
    at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
    taken += 1;
  }
  return { text: text.slice(from, at), cut: at < text.length };
}

/**
 * Pure rendering of one recalled memory. `rank` is 1-based (retriever order among the delivered entries). The result
 * is not yet token-budgeted: the context builder applies its budget afterwards, unchanged.
 */
export function renderRecallContent(
  content: string,
  matchedPassageOrdinal: number | undefined,
  rank: number,
  variant: RecallExcerptVariant,
): string {
  const head = (): string =>
    content.length > RECALL_EXCERPT_DEFAULT_CHARS
      ? `${content.slice(0, RECALL_EXCERPT_DEFAULT_CHARS)}${ELLIPSIS}`
      : content;
  if (variant === 'V0' || matchedPassageOrdinal === undefined) return head();
  const start = memoryPassageStartOffset(content, matchedPassageOrdinal);
  if (start === undefined) return head();
  const max =
    variant === 'V2' && rank >= 1 && rank <= RECALL_EXCERPT_TOP_RANKS
      ? RECALL_EXCERPT_TOP_RANK_CHARS
      : RECALL_EXCERPT_DEFAULT_CHARS;
  const slice = codePointSlice(content, start, max);
  return `${start > 0 ? ELLIPSIS : ''}${slice.text}${slice.cut ? ELLIPSIS : ''}`;
}
