import { createHash } from 'node:crypto';
import {
  blockRanges,
  graphemeRanges,
  lineRanges,
  listItemRanges,
  sentenceRanges,
  type PieceLimit,
  type Range,
} from './boundaries';
import { CodePointIndex } from './code-points';
import { estimateTokenWeight } from './token-estimate';
import type { ChunkSection, Passage, PassageKind, PassageRows, Span } from './types';

/** ADR-0124 section 3.2 (proposed defaults; the token bound is recalibrated per model in phase 1). */
export const PASSAGE_TARGET_CODE_POINTS = 800;
export const PASSAGE_MAX_CODE_POINTS = 1_200;
export const PASSAGE_MAX_TOKENS = 600;
/** ADR-0124 section 3.3: an overlap is at most 150 code points and 15% of the passage. */
export const OVERLAP_MAX_CODE_POINTS = 150;
export const OVERLAP_MAX_FRACTION = 0.15;
/** A sheet header row longer than this is not repeated in a window. */
export const TABLE_HEADER_REPEAT_MAX_CODE_POINTS = 300;
/** A frame (Quoky's section label) is cut to this many code points. */
export const FRAME_MAX_CODE_POINTS = 120;
/** Lines of overlap when a long code block is split. */
const CODE_OVERLAP_LINES = 2;

const PASSAGE_LIMIT: PieceLimit = { maxCodePoints: PASSAGE_MAX_CODE_POINTS, maxTokens: PASSAGE_MAX_TOKENS };

interface Unit extends Range {
  readonly kind: PassageKind;
  /** The block (or row) the unit came from, to tell a split block from two blocks. */
  readonly origin: number;
  /** The unit is a piece of an over-long block, so a cut between two such pieces carries an overlap. */
  readonly split: boolean;
  readonly heading: boolean;
  readonly row?: number;
  readonly points: number;
  readonly weight: number;
}

interface Draft {
  readonly units: Unit[];
  readonly frame: string;
  readonly table: boolean;
  /** The section's header row, when this table draft should repeat it. */
  readonly header?: Range & { readonly points: number; readonly weight: number };
  points: number;
  weight: number;
}

/** One line, bounded: a frame is Quoky's label but it may carry a (guarded) title. */
function oneLineFrame(frame: string): string {
  const text = frame.replace(/\s+/gu, ' ').trim();
  if (Array.from(text).length <= FRAME_MAX_CODE_POINTS) return text;
  const whole = new CodePointIndex(text);
  const ranges = graphemeRanges(text, { start: 0, end: text.length }, { maxCodePoints: FRAME_MAX_CODE_POINTS, maxTokens: Infinity }, whole);
  return ranges[0] === undefined ? '' : text.slice(ranges[0].start, ranges[0].end);
}

function unitOf(text: string, index: CodePointIndex, range: Range, rest: Omit<Unit, keyof Range | 'points' | 'weight'>): Unit {
  return { ...range, ...rest, points: index.countUnits(range.start, range.end), weight: estimateTokenWeight(text.slice(range.start, range.end)) };
}

function fitsLimit(points: number, weight: number, limit: PieceLimit): boolean {
  return points <= limit.maxCodePoints && weight <= limit.maxTokens;
}

/**
 * Pieces of an over-long range, in the order of ADR-0124 section 3.4: code lines, list items, then sentences, then
 * graphemes. Every piece fits the limit; the pieces partition the range.
 */
function splitOversized(text: string, index: CodePointIndex, range: Range, kind: PassageKind, limit: PieceLimit): Range[] {
  const fits = (piece: Range): boolean =>
    fitsLimit(index.countUnits(piece.start, piece.end), estimateTokenWeight(text.slice(piece.start, piece.end)), limit);
  const bySentence = (piece: Range): Range[] =>
    sentenceRanges(text, piece).flatMap((sentence) => (fits(sentence) ? [sentence] : graphemeRanges(text, sentence, limit, index)));
  const first: Range[] = kind === 'code' ? lineRanges(text, range) : kind === 'list' ? listItemRanges(text, range) : sentenceRanges(text, range);
  const second = kind === 'code' || kind === 'list';
  return first.flatMap((piece) => {
    if (fits(piece)) return [piece];
    return second ? bySentence(piece) : graphemeRanges(text, piece, limit, index);
  });
}

function textUnits(text: string, index: CodePointIndex, range: Range, originBase: number): Unit[] {
  const units: Unit[] = [];
  blockRanges(text, range).forEach((block, order) => {
    const origin = originBase + order;
    const blockUnit = unitOf(text, index, block, { kind: block.kind, origin, split: false, heading: block.heading });
    if (fitsLimit(blockUnit.points, blockUnit.weight, PASSAGE_LIMIT)) {
      units.push(blockUnit);
      return;
    }
    for (const piece of splitOversized(text, index, block, block.kind, PASSAGE_LIMIT)) {
      units.push(unitOf(text, index, piece, { kind: block.kind, origin, split: true, heading: false }));
    }
  });
  return units;
}

function pack(units: readonly Unit[], frame: string, table: boolean, header: Draft['header'], allowance: { points: number; weight: number }): Draft[] {
  const drafts: Draft[] = [];
  let current: Draft | undefined;
  const open = (): Draft => {
    // The first draft of a table holds its header row itself; later ones repeat it, so the repeat is part of their size.
    const repeat = table && drafts.length > 0 ? header : undefined;
    return { units: [], frame, table, ...(repeat === undefined ? {} : { header: repeat }), points: repeat?.points ?? 0, weight: repeat?.weight ?? 0 };
  };
  const flush = (): void => {
    if (current !== undefined && current.units.length > 0) drafts.push(current);
    current = undefined;
  };
  for (const unit of units) {
    if (current === undefined) current = open();
    const startsSection = unit.heading && current.units.length > 0 && !current.units.every((held) => held.heading);
    const overflows = current.units.length > 0 && !fitsLimit(current.points + unit.points, current.weight + unit.weight, {
      maxCodePoints: allowance.points,
      maxTokens: allowance.weight,
    });
    if (startsSection || overflows) {
      flush();
      current = open();
    }
    current.units.push(unit);
    current.points += unit.points;
    current.weight += unit.weight;
    if (current.points >= PASSAGE_TARGET_CODE_POINTS || current.weight >= PASSAGE_MAX_TOKENS) flush();
  }
  flush();
  return drafts;
}

function tableUnits(text: string, index: CodePointIndex, range: Range, originBase: number, headerPoints: number, headerWeight: number): Unit[] {
  const rows: Range[] = [];
  for (const line of lineRanges(text, range)) {
    const last = rows[rows.length - 1];
    if (text.slice(line.start, line.end).trim() === '' && last !== undefined) rows[rows.length - 1] = { start: last.start, end: line.end };
    else rows.push(line);
  }
  const limit: PieceLimit = {
    maxCodePoints: Math.max(1, PASSAGE_MAX_CODE_POINTS - headerPoints),
    maxTokens: Math.max(1, PASSAGE_MAX_TOKENS - headerWeight),
  };
  const units: Unit[] = [];
  rows.forEach((row, order) => {
    const whole = unitOf(text, index, row, { kind: 'table', origin: originBase + order, split: false, heading: false, row: order });
    if (fitsLimit(whole.points, whole.weight, limit)) {
      units.push(whole);
      return;
    }
    for (const piece of splitOversized(text, index, row, 'prose', limit)) {
      units.push(unitOf(text, index, piece, { kind: 'table', origin: originBase + order, split: true, heading: false, row: order }));
    }
  });
  return units;
}

function spanOf(index: CodePointIndex, range: Range): Span {
  return { start: index.toPoint(range.start), end: index.toPoint(range.end) };
}

function kindOf(units: readonly Unit[], table: boolean): PassageKind {
  if (table) return 'table';
  const first = units[0]?.kind ?? 'prose';
  return units.every((unit) => unit.kind === first) ? first : 'prose';
}

/** The overlap of a draft with the one before it, when a block was split between them. */
function overlapFor(index: CodePointIndex, previous: Draft | undefined, draft: Draft): Range | undefined {
  if (previous === undefined || draft.table) return undefined;
  const last = previous.units[previous.units.length - 1];
  const first = draft.units[0];
  if (last === undefined || first === undefined || !last.split || !first.split || last.origin !== first.origin) return undefined;
  const code = last.kind === 'code';
  let from = previous.units.length - 1;
  if (code) {
    for (let taken = 1; taken < CODE_OVERLAP_LINES && from > 0 && previous.units[from - 1]?.origin === last.origin; taken += 1) from -= 1;
  }
  const start = previous.units[from]?.start ?? last.start;
  const points = index.countUnits(start, last.end);
  const cap = Math.min(OVERLAP_MAX_CODE_POINTS, Math.floor(OVERLAP_MAX_FRACTION * draft.points));
  // The passage input INCLUDING the overlap stays within the passage cap; an overlap that would not fit is dropped.
  return points > 0 && points <= cap && draft.points + points <= PASSAGE_MAX_CODE_POINTS ? { start, end: last.end } : undefined;
}

/** Quoky's own sections of a prepared text, as `{frame, body}` parts: joins them (blank line between) and tiles the result. */
export function joinSections(
  parts: readonly { readonly frame: string; readonly body: string; readonly kind?: 'text' | 'table'; readonly firstRow?: number }[],
): { readonly text: string; readonly sections: readonly ChunkSection[] } {
  let text = '';
  const sections: ChunkSection[] = [];
  const index = { value: 0 };
  parts.forEach((part, order) => {
    const body = order < parts.length - 1 ? `${part.body}\n\n` : part.body;
    const start = index.value;
    text += body;
    index.value += Array.from(body).length;
    sections.push({
      frame: part.frame,
      start,
      end: index.value,
      ...(part.kind === undefined ? {} : { kind: part.kind }),
      ...(part.firstRow === undefined ? {} : { firstRow: part.firstRow }),
    });
  });
  return { text, sections };
}

function validateSections(sections: readonly ChunkSection[], length: number): void {
  let at = 0;
  for (const section of sections) {
    if (section.start !== at || section.end < section.start) throw new RangeError('chunk sections must tile the prepared text');
    at = section.end;
  }
  if (at !== length) throw new RangeError('chunk sections must tile the prepared text');
}

/**
 * ADR-0124 section 3: splits ONE prepared item into passages. `prepared` is the normalized, link-neutralized,
 * credential-guarded text (the caller guards the full item first); `sections` optionally tiles it into Quoky's own
 * sections (sheets, thread messages). The passages' spans partition the text exactly and none crosses a section.
 * Deterministic, in memory, with no I/O: it keeps nothing after it returns.
 */
export function chunk(prepared: string, sections?: readonly ChunkSection[]): Passage[] {
  if (typeof prepared !== 'string') throw new TypeError('chunk takes exactly one prepared item (a string)');
  if (sections !== undefined && !Array.isArray(sections)) throw new TypeError('chunk takes exactly one prepared item; sections must be a list of its sections');
  if (prepared.length === 0) return [];
  const index = new CodePointIndex(prepared);
  const list: readonly ChunkSection[] = sections !== undefined && sections.length > 0 ? sections : [{ frame: '', start: 0, end: index.length }];
  validateSections(list, index.length);
  const all: Draft[] = [];
  const previousByDraft = new Map<Draft, Draft | undefined>();
  let originBase = 0;
  for (const section of list) {
    const range: Range = { start: index.toUnit(section.start), end: index.toUnit(section.end) };
    if (range.end <= range.start) continue;
    const frame = oneLineFrame(section.frame);
    let drafts: Draft[];
    if (section.kind === 'table') {
      const lines = lineRanges(prepared, range);
      const headerLine = lines[0];
      const headerRange = headerLine === undefined ? undefined : { start: headerLine.start, end: headerLine.end };
      const headerPoints = headerRange === undefined ? 0 : index.countUnits(headerRange.start, headerRange.end);
      const repeatable = headerRange !== undefined && lines.length > 1 && headerPoints <= TABLE_HEADER_REPEAT_MAX_CODE_POINTS;
      const header = repeatable ? { ...headerRange, points: headerPoints, weight: estimateTokenWeight(prepared.slice(headerRange.start, headerRange.end)) } : undefined;
      const units = tableUnits(prepared, index, range, originBase, header?.points ?? 0, header?.weight ?? 0);
      drafts = pack(units, frame, true, header, { points: PASSAGE_MAX_CODE_POINTS, weight: PASSAGE_MAX_TOKENS });
    } else {
      drafts = pack(textUnits(prepared, index, range, originBase), frame, false, undefined, { points: PASSAGE_MAX_CODE_POINTS, weight: PASSAGE_MAX_TOKENS });
    }
    originBase += 1_000_000;
    drafts.forEach((draft, order) => previousByDraft.set(draft, order === 0 ? undefined : drafts[order - 1]));
    all.push(...drafts);
  }
  const total = all.length;
  return all.map((draft, ordinal): Passage => {
    const first = draft.units[0] as Unit;
    const last = draft.units[draft.units.length - 1] as Unit;
    const range: Range = { start: first.start, end: last.end };
    const text = prepared.slice(range.start, range.end);
    const overlap = overlapFor(index, previousByDraft.get(draft), draft);
    let weight = estimateTokenWeight(text);
    if (overlap !== undefined) weight += estimateTokenWeight(prepared.slice(overlap.start, overlap.end));
    let rows: PassageRows | undefined;
    if (draft.table) {
      const numbers = draft.units.map((unit) => unit.row ?? 0);
      const base = sectionFirstRow(list, index, range);
      rows = {
        first: base + Math.min(...numbers),
        last: base + Math.max(...numbers),
        ...(draft.header === undefined ? {} : { headerSpan: spanOf(index, draft.header) }),
      };
      weight += draft.header?.weight ?? 0;
    }
    return {
      ordinal,
      total,
      frame: draft.frame,
      kind: kindOf(draft.units, draft.table),
      span: spanOf(index, range),
      ...(overlap === undefined ? {} : { overlap: spanOf(index, overlap) }),
      ...(rows === undefined ? {} : { rows }),
      ...(draft.points > PASSAGE_MAX_CODE_POINTS ? { overCap: true as const } : {}),
      estTokens: Math.ceil(weight),
      contentHash: createHash('sha256').update(text.trim()).digest('hex'),
    };
  });
}

/** The `firstRow` of the table section that holds `range`. */
function sectionFirstRow(list: readonly ChunkSection[], index: CodePointIndex, range: Range): number {
  const at = index.toPoint(range.start);
  return list.find((section) => section.start <= at && at < section.end)?.firstRow ?? 1;
}
