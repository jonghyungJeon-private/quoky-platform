import { chunk, CodePointIndex } from '../chunking';
import type { Id } from '../../domain';

/**
 * ADR-0124 section 5 (P2-2): how one durable memory maps onto stored vectors.
 *
 * A memory that fits in one passage keeps exactly one vector whose id is the memory id and whose text is the whole
 * content (byte-identical to the single-vector path). A longer memory gets one vector per passage with ids
 * `<memoryId>#<ordinal>`; the memory's semantic score is the maximum cosine over its passages. The unit list is a pure
 * function of the content, so scoring, indexing and removal all agree on the ids without a lookup.
 */

/** Upper bound on passages indexed per memory (a defensive cap on store growth; longer tails are not indexed). */
export const MAX_PASSAGES_PER_MEMORY = 64;

export interface MemoryVectorUnit {
  /** The id the vector is stored under: the memory id, or `<memoryId>#<ordinal>`. */
  readonly vectorId: Id;
  /** The text that is embedded for this vector. */
  readonly text: string;
}

export function passageVectorId(memoryId: Id, ordinal: number): Id {
  return `${memoryId}#${ordinal}`;
}

/** Every vector id a memory can have in a store: its own id and its passage ids. Used by forget to remove them all. */
export function allMemoryVectorIds(memoryId: Id): Id[] {
  const ids: Id[] = [memoryId];
  for (let ordinal = 0; ordinal < MAX_PASSAGES_PER_MEMORY; ordinal += 1) ids.push(passageVectorId(memoryId, ordinal));
  return ids;
}

/** The vector units of a memory. `multiVector: false` always yields the single whole-content unit. */
export function memoryVectorUnits(memoryId: Id, content: string, multiVector: boolean): MemoryVectorUnit[] {
  const whole: MemoryVectorUnit[] = [{ vectorId: memoryId, text: content }];
  if (!multiVector) return whole;
  let texts: string[];
  try {
    const passages = chunk(content);
    if (passages.length <= 1) return whole;
    const index = new CodePointIndex(content);
    texts = passages.map((passage) => index.slice(passage.span.start, passage.span.end));
  } catch {
    // A chunker failure must never lose the memory: it keeps the single-vector form.
    return whole;
  }
  const units: MemoryVectorUnit[] = [];
  texts.slice(0, MAX_PASSAGES_PER_MEMORY).forEach((text, ordinal) => {
    if (text.trim().length > 0) units.push({ vectorId: passageVectorId(memoryId, ordinal), text });
  });
  return units.length === 0 ? whole : units;
}

/**
 * ADR-0124 P2-6: the UTF-16 offset in `content` at which passage `ordinal` starts, for a memory that is indexed as
 * several passages (the same units `memoryVectorUnits(.., true)` yields). `undefined` for a single-unit memory, an
 * unknown or empty passage, or a chunker failure: the caller then falls back to the head of the content.
 */
export function memoryPassageStartOffset(content: string, ordinal: number): number | undefined {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= MAX_PASSAGES_PER_MEMORY) return undefined;
  try {
    const passages = chunk(content);
    if (passages.length <= 1) return undefined;
    const passage = passages[ordinal];
    if (passage === undefined) return undefined;
    const index = new CodePointIndex(content);
    if (index.slice(passage.span.start, passage.span.end).trim().length === 0) return undefined;
    return index.toUnit(passage.span.start);
  } catch {
    return undefined;
  }
}
