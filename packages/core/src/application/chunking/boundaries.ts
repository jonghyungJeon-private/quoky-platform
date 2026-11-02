import { CodePointIndex } from './code-points';
import { estimateTokenWeight } from './token-estimate';
import type { PassageKind } from './types';

/**
 * ADR-0124 section 3.4: where a text may be cut, by priority. Everything here is structural: line shapes (heading
 * marker, list marker, quote marker, code fence), blank lines, `Intl.Segmenter` sentence and grapheme boundaries. There is
 * no phrase list and no guess from wording. Ranges are UTF-16 offsets into one text; callers convert with
 * {@link CodePointIndex}.
 */
export interface Range {
  readonly start: number;
  readonly end: number;
}

export type BlockKind = Exclude<PassageKind, 'table'>;

export interface Block extends Range {
  readonly kind: BlockKind;
  /** A Markdown heading line: a passage boundary comes before it. */
  readonly heading: boolean;
}

interface MutableBlock {
  start: number;
  end: number;
  kind: BlockKind;
  heading: boolean;
}

const HEADING_LINE = /^#{1,6}[ \t]/u;
const FENCE_LINE = /^[ \t]*(?:```|~~~)/u;
const LIST_ITEM_LINE = /^[ \t]{0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+/u;
const QUOTE_LINE = /^[ \t]*>/u;
const INDENTED_LINE = /^[ \t]+\S/u;
const HANGUL = /\p{Script=Hangul}/u;

/** The lines of a range, each with its trailing newline. */
export function lineRanges(text: string, range: Range): Range[] {
  const lines: Range[] = [];
  for (let at = range.start; at < range.end; ) {
    const newline = text.indexOf('\n', at);
    const end = newline === -1 || newline >= range.end ? range.end : newline + 1;
    lines.push({ start: at, end });
    at = end;
  }
  return lines;
}

function lineBody(text: string, line: Range): string {
  const end = text[line.end - 1] === '\n' ? line.end - 1 : line.end;
  return text.slice(line.start, end);
}

/**
 * Blocks of a range, partitioning it: fenced code (kept whole), Markdown headings (a line of their own), quote runs,
 * list runs and paragraphs separated by blank lines. Blank lines belong to the block before them.
 */
export function blockRanges(text: string, range: Range): Block[] {
  const blocks: MutableBlock[] = [];
  let current: MutableBlock | undefined;
  let inFence = false;
  let previousBlank = false;
  let carry: number | undefined;
  const flush = (): void => {
    if (current !== undefined) blocks.push(current);
    current = undefined;
  };
  for (const line of lineRanges(text, range)) {
    const body = lineBody(text, line);
    if (inFence) {
      if (current !== undefined) current.end = line.end;
      if (FENCE_LINE.test(body)) {
        inFence = false;
        flush();
      }
      continue;
    }
    if (FENCE_LINE.test(body)) {
      flush();
      current = { start: carry ?? line.start, end: line.end, kind: 'code', heading: false };
      carry = undefined;
      inFence = true;
      previousBlank = false;
      continue;
    }
    if (body.trim() === '') {
      const tail = current ?? blocks[blocks.length - 1];
      if (tail !== undefined) tail.end = line.end;
      else carry = carry ?? line.start;
      previousBlank = true;
      continue;
    }
    const start = (): void => {
      flush();
      current = { start: carry ?? line.start, end: line.end, kind: 'prose', heading: false };
      carry = undefined;
    };
    if (HEADING_LINE.test(body)) {
      start();
      if (current !== undefined) (current as MutableBlock).heading = true;
      flush();
      previousBlank = false;
      continue;
    }
    const kind: BlockKind = QUOTE_LINE.test(body) ? 'quote' : LIST_ITEM_LINE.test(body) ? 'list' : 'prose';
    const lazyListContinuation = current?.kind === 'list' && kind === 'prose' && !previousBlank && INDENTED_LINE.test(body);
    if (current !== undefined && !previousBlank && (current.kind === kind || lazyListContinuation)) {
      current.end = line.end;
    } else {
      start();
      if (current !== undefined) (current as MutableBlock).kind = kind;
    }
    previousBlank = false;
  }
  flush();
  if (blocks.length === 0 && range.end > range.start) blocks.push({ start: range.start, end: range.end, kind: 'prose', heading: false });
  return blocks;
}

const segmenters = new Map<string, Intl.Segmenter>();
function segmenter(locale: string, granularity: 'sentence' | 'grapheme'): Intl.Segmenter {
  const key = `${locale}:${granularity}`;
  let found = segmenters.get(key);
  if (found === undefined) {
    found = new Intl.Segmenter(locale, { granularity });
    segmenters.set(key, found);
  }
  return found;
}

/** Sentences of a range (`Intl.Segmenter`; the Korean rules when the range holds Hangul). Partitions the range. */
export function sentenceRanges(text: string, range: Range): Range[] {
  const slice = text.slice(range.start, range.end);
  const locale = HANGUL.test(slice) ? 'ko' : 'en';
  const out: Range[] = [];
  for (const part of segmenter(locale, 'sentence').segment(slice)) {
    out.push({ start: range.start + part.index, end: range.start + part.index + part.segment.length });
  }
  return out;
}

/** List items of a range: each starts at a list-marker line. Partitions the range. */
export function listItemRanges(text: string, range: Range): Range[] {
  const starts: number[] = [];
  for (const line of lineRanges(text, range)) {
    if (LIST_ITEM_LINE.test(lineBody(text, line))) starts.push(line.start);
  }
  if (starts.length === 0 || starts[0] !== range.start) starts.unshift(range.start);
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? range.end }));
}

export interface PieceLimit {
  readonly maxCodePoints: number;
  readonly maxTokens: number;
}

/**
 * The last resort: pieces within the limits cut on grapheme boundaries, so a surrogate pair, a Hangul syllable or an
 * emoji sequence is never split. A single grapheme beyond the limit is returned whole as one over-limit piece (never cut
 * inside a cluster); the caller must treat that piece as over-cap.
 */
export function graphemeRanges(text: string, range: Range, limit: PieceLimit, index: CodePointIndex): Range[] {
  const out: Range[] = [];
  const slice = text.slice(range.start, range.end);
  let pieceStart = range.start;
  let points = 0;
  let weight = 0;
  const close = (end: number): void => {
    if (end > pieceStart) out.push({ start: pieceStart, end });
    pieceStart = end;
    points = 0;
    weight = 0;
  };
  for (const part of segmenter('en', 'grapheme').segment(slice)) {
    const absolute = range.start + part.index;
    const size = index.countUnits(absolute, absolute + part.segment.length);
    const cost = estimateTokenWeight(part.segment);
    if (points > 0 && (points + size > limit.maxCodePoints || weight + cost > limit.maxTokens)) close(absolute);
    if (size > limit.maxCodePoints) {
      // One grapheme longer than the bound (stacked combining marks). Never cut inside a grapheme cluster: it becomes a
      // piece of its own that exceeds the limit; passages.ts marks that passage `overCap` and pack.ts keeps it out of
      // every window (ADR-0124 section 3.4 implementation note).
      pieceStart = absolute;
      close(absolute + part.segment.length);
      continue;
    }
    points += size;
    weight += cost;
  }
  close(range.end);
  return out;
}

/** Whether a text line is a list-item line (exported for tests of the shape rules). */
export function isListItemLine(line: string): boolean {
  return LIST_ITEM_LINE.test(line);
}
