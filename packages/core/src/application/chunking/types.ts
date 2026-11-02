/**
 * ADR-0124 chunking: the shared types. Everything here is structural (counts, offsets, hashes); a passage carries no
 * text, so a passage can be logged or audited without leaking content. The text is read from the prepared item by span.
 */

/** What a passage is made of. `mixed` content is labelled `prose`. */
export type PassageKind = 'prose' | 'list' | 'table' | 'code' | 'quote';

/** A half-open range `[start, end)` of CODE POINTS of the prepared text (never UTF-16 units). */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A sheet passage: the data rows it holds and, when repeatable, where its sheet's header row is. */
export interface PassageRows {
  /** First row number held (the header row is row `firstRow` of the section). */
  readonly first: number;
  readonly last: number;
  /** The section's header row; set only when this passage does not already start at it and the row is short enough to repeat. */
  readonly headerSpan?: Span;
}

export interface Passage {
  /** 0-based position among the item's passages, in `[0, total)` (a selection is a sorted list of these). */
  readonly ordinal: number;
  readonly total: number;
  /** Quoky's own label of the section the passage lies in (`[Sheet 3/20] "…"`, `[메시지 7/14]`), '' when the item has no sections. */
  readonly frame: string;
  readonly kind: PassageKind;
  /** The passage's text in the prepared item. The spans of all passages partition the prepared item exactly. */
  readonly span: Span;
  /** One sentence (or two code lines) of the previous passage, carried for context when a paragraph or code block was split. */
  readonly overlap?: Span;
  readonly rows?: PassageRows;
  /** The estimate of {@link estimateTokens} over everything the passage renders (overlap and header row included). */
  readonly estTokens: number;
  /** sha256 of the passage text; for de-duplication and content-free audit only. */
  readonly contentHash: string;
}

/**
 * One section of the prepared item, given by Quoky (a sheet, a thread message, a Jira comment). Sections must tile the
 * prepared text: the first starts at 0, each starts where the previous ended, the last ends at the text's end.
 */
export interface ChunkSection {
  readonly frame: string;
  readonly start: number;
  readonly end: number;
  /** `table`: the section is rows, one per line, the first line being the header row. Default `text`. */
  readonly kind?: 'text' | 'table';
  /** The row number of the section's first line, from the connector. Default 1. */
  readonly firstRow?: number;
}

/** One packed window: the unit a model reads. */
export interface Window {
  readonly text: string;
  /** Ordinals of the passages in it, in document order. */
  readonly ordinals: readonly number[];
  readonly codePoints: number;
  readonly estTokens: number;
}

export interface WindowBudget {
  /** The hard bound; the same as `UNTRUSTED_DOCUMENT_BODY_MAX_CHARS`. */
  readonly maxCodePoints: number;
  /** The packing bound (a window of one passage may exceed it; the code-point bound is never exceeded). */
  readonly maxEstTokens: number;
}
