/**
 * Maps between UTF-16 offsets (what `String` indexes) and code-point offsets (what every Quoky bound counts), in O(1)
 * after one pass. A text with no surrogate pair maps by identity and allocates nothing.
 */
export class CodePointIndex {
  readonly text: string;
  /** Length in code points. */
  readonly length: number;
  private readonly units: Uint32Array | undefined; // code-point offset -> UTF-16 offset (length + 1 entries)
  private readonly points: Uint32Array | undefined; // UTF-16 offset -> code-point offset (text.length + 1 entries)

  constructor(text: string) {
    this.text = text;
    if (!/[\uD800-\uDBFF]/.test(text)) {
      this.length = text.length;
      return;
    }
    const units: number[] = [];
    const points = new Uint32Array(text.length + 1);
    let count = 0;
    for (let at = 0; at < text.length; ) {
      units.push(at);
      points[at] = count;
      const width = (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
      if (width === 2) points[at + 1] = count;
      at += width;
      count += 1;
    }
    units.push(text.length);
    points[text.length] = count;
    this.length = count;
    this.units = Uint32Array.from(units);
    this.points = points;
  }

  /** The UTF-16 offset of a code-point offset. */
  toUnit(point: number): number {
    return this.units === undefined ? point : (this.units[point] ?? this.text.length);
  }

  /** The code-point offset of a UTF-16 offset (a position inside a pair maps to the pair's start). */
  toPoint(unit: number): number {
    return this.points === undefined ? unit : (this.points[unit] ?? this.length);
  }

  /** Code points between two UTF-16 offsets. */
  countUnits(startUnit: number, endUnit: number): number {
    return this.toPoint(endUnit) - this.toPoint(startUnit);
  }

  /** The text of a code-point range. */
  slice(start: number, end: number): string {
    return this.text.slice(this.toUnit(start), this.toUnit(end));
  }
}

/** Code points in a string. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) at += 1;
    }
    count += 1;
  }
  return count;
}
