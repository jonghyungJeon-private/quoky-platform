import type { MessageBody, MessageContent, MessageLengthUnit, MessageMarkup, MessageNode } from '@quoky/core';

/**
 * TG-3: CommonMark on Telegram in PLAIN mode (ADR-0114 D7; the TG-1 residual "Quoky copy in plain mode shows `**`,
 * backticks and fences as written").
 *
 * Why plain and not `parse_mode: HTML`. ADR-0114 D7 fixes plain text by default and allows HTML only for code and diff
 * previews (`<pre>` / `<code>`). Plain mode is also the safer of the two: Telegram interprets NOTHING, so whatever the
 * translation does it can only remove or replace characters of Quoky's own copy; it can never make text bold, a link
 * or a mention. With HTML every node would have to be escaped exactly right forever, and one miss in an untrusted span
 * would be markup. So the translation below runs on plain text and produces plain text.
 *
 * What is translated, and what never is:
 * - **Translated:** Quoky-authored string nodes of a `MessageContent`, a plain `text` body (Quoky copy alone, PLT-0),
 *   and a `format: 'model-reply'` answer.
 * - **Never translated:** an `untrusted` span (connector readouts, calendar titles, the owner's own words, write
 *   payloads), a link and a conversation reference. They are opaque atoms: no marker inside them is read, removed or
 *   paired, and no line inside them is a heading, a list item or a fence. Text inside a fenced block (which may carry
 *   untrusted text, PLT-0) is kept verbatim too.
 *
 * The rules (a minimal CommonMark subset):
 * - Fenced code blocks (``` or ~~~, 3+, CommonMark closing rule): the fence LINES are removed, the content is kept
 *   exactly, with no indentation added, so code and diffs can still be copied as they are. An unclosed fence runs to
 *   the end, as in CommonMark.
 * - ATX headings (`#` to `######`): the markers (and an optional closing `#` run) are removed; the heading is a plain line.
 * - Bullet list items (`-`, `*`, `+`): the marker becomes `•`, indentation kept. Ordered lists are kept as written.
 * - A thematic break (`---`, `***`, `___`) is kept as written.
 * - Emphasis and strong emphasis (`*`, `_`, `**`, `__`, `***`): the delimiters are removed when they pair under the
 *   CommonMark flanking rules (so `snake_case`, `2 * 3` and a lone `*` stay). An atom counts as a letter, so the
 *   `**${label} ` + untrusted + `** (n건)` shape of Quoky copy pairs across it.
 * - Code spans: the backtick runs are removed and the content is kept literally (no emphasis inside).
 * Not translated (shown as written): links `[text](url)`, block quotes, backslash escapes, tables, indented code.
 *
 * The translation never makes a text longer (`•` is one UTF-16 unit, like `-`), so a Core budget or the 4096 bound that
 * held before it still holds after it, and the adapter's lossless chunker then splits the translated text.
 */

/** A piece of rendered text: Quoky copy (translatable) or an opaque span (never translated). */
export interface TelegramSegment {
  readonly text: string;
  readonly span: boolean;
}

type Segments = TelegramSegment[];

const copy = (text: string): TelegramSegment => ({ text, span: false });
const atom = (text: string): TelegramSegment => ({ text, span: true });

function concat(segments: readonly TelegramSegment[]): string {
  let text = '';
  for (const segment of segments) text += segment.text;
  return text;
}

function measure(text: string, unit: MessageLengthUnit): number {
  return unit === 'utf16' ? text.length : Array.from(text).length;
}

/** The segments covering UTF-16 offsets [start, end) of their concatenation (a segment may be cut). */
function slice(segments: readonly TelegramSegment[], start: number, end: number): Segments {
  const out: Segments = [];
  let at = 0;
  for (const segment of segments) {
    const from = Math.max(start - at, 0);
    const to = Math.min(end - at, segment.text.length);
    if (from < to) out.push({ text: segment.text.slice(from, to), span: segment.span });
    at += segment.text.length;
  }
  return out;
}

/** The first `count` units of the segments (as Core's `head`). */
function head(segments: readonly TelegramSegment[], count: number, unit: MessageLengthUnit): Segments {
  if (unit === 'utf16') return slice(segments, 0, count);
  const kept = Array.from(concat(segments)).slice(0, count).join('');
  return slice(segments, 0, kept.length);
}

function trim(segments: readonly TelegramSegment[]): Segments {
  const text = concat(segments);
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return start >= end ? [] : slice(segments, start, end);
}

function joinLines(lines: readonly Segments[]): Segments {
  const out: Segments = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push(copy('\n'));
    out.push(...line);
  });
  return out;
}

/**
 * Core's content evaluator (`application/message-rendering.ts`), node for node, keeping which text is copy and which is
 * a span. Its concatenation equals `renderMessageContent(content, markup)`; {@link translateTelegramBody} checks that
 * and translates nothing when it does not hold (a Core change this copy does not know).
 */
function render(content: MessageContent, markup: MessageMarkup): Segments {
  const out: Segments = [];
  for (const node of content) out.push(...renderNode(node, markup));
  return out;
}

function renderNode(node: MessageNode, markup: MessageMarkup): Segments {
  if (typeof node === 'string') return [copy(node)];
  switch (node.kind) {
    case 'untrusted':
      return [atom(markup.untrusted(node.text, node.guard))];
    case 'link':
      return [atom(markup.link(node.url))];
    case 'conversation':
      return [atom(markup.conversation(node))];
    case 'platform-note':
      return [atom(markup.platformNote(node.topic))];
    case 'clip': {
      const after = node.after ? render(node.after, markup) : [];
      const budget = node.maxChars - measure(concat(after), node.unit);
      const rendered = render(node.content, markup);
      const text = node.trim ? trim(rendered) : rendered;
      if (measure(concat(text), node.unit) <= budget) return [...text, ...after];
      if (budget <= 0) return after;
      return [...head(text, budget - 1, node.unit), copy('…'), ...after];
    }
    case 'fit-lines': {
      const rendered = node.lines.map((line) => render(line.content, markup));
      const kept = rendered.map((_, index) => index);
      let dropped = false;
      const join = (): Segments => {
        const text = joinLines(kept.map((index) => rendered[index] as Segments));
        return dropped && node.omittedNote !== undefined ? [...text, copy(`\n${node.omittedNote}`)] : text;
      };
      while (concat(join()).length > node.maxChars) {
        let at = -1;
        for (let k = kept.length - 1; k >= 0; k -= 1) {
          if (node.lines[kept[k] as number]?.droppable) {
            at = k;
            break;
          }
        }
        if (at < 0) break;
        kept.splice(at, 1);
        dropped = true;
      }
      const text = join();
      return concat(text).length <= node.maxChars ? text : [...slice(text, 0, node.maxChars - 1), copy('…')];
    }
    case 'take-lines': {
      const heads = node.head.map((line) => render(line, markup));
      const tails = node.tail.map((line) => render(line, markup));
      let length = node.baseChars + [...heads, ...tails].reduce((sum, line) => sum + measure(concat(line), node.unit), 0);
      const taken: Array<{ text: Segments; item: boolean }> = [];
      let omitted = node.omitted?.hidden ?? 0;
      for (const [index, line] of node.lines.entries()) {
        const text = render(line.content, markup);
        const size = measure(concat(text), node.unit) + 1;
        if (length + size > node.maxChars) {
          omitted += node.lines.slice(index).filter((entry) => entry.item === true).length;
          break;
        }
        taken.push({ text, item: line.item === true });
        length += size;
      }
      if (node.dropTrailingHeadings) {
        while (taken.length > 0 && !(taken[taken.length - 1] as { item: boolean }).item) taken.pop();
      }
      const lines = taken.map((line) => line.text);
      if (node.omitted && omitted > 0) lines.push([copy(`${node.omitted.before}${omitted}${node.omitted.after}`)]);
      const shownHead = node.headOnlyWithLines && taken.length === 0 ? [] : heads;
      return joinLines([...shownHead, ...lines, ...tails]);
    }
    case 'first-fit': {
      let text: Segments = [];
      for (const candidate of node.candidates) {
        text = render(candidate, markup);
        if (measure(concat(text), node.unit) <= node.maxChars) return text;
      }
      return text;
    }
  }
}

/** The rendered body as copy and span segments (a string body is one copy segment). */
export function telegramSegments(body: MessageBody, markup: MessageMarkup): TelegramSegment[] {
  return typeof body === 'string' ? [copy(body)] : render(body, markup);
}

// ── The translation ───────────────────────────────────────────────────────────────────────────────────────────────

/** One unit of a line: a single character of copy, or a whole opaque span. */
interface Unit {
  readonly text: string;
  readonly atom: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const HEADING_CLOSE = /[ \t]+#+[ \t]*$/;
const BULLET = /^([ \t]*)[-*+][ \t]+/;

function lineText(line: readonly TelegramSegment[]): string {
  return concat(line);
}

function copyOnly(line: readonly TelegramSegment[]): boolean {
  return line.every((segment) => !segment.span);
}

/** Split segments into lines on the newlines of COPY only; a span is never split and its newlines start no line. */
function lines(segments: readonly TelegramSegment[]): TelegramSegment[][] {
  const out: TelegramSegment[][] = [[]];
  for (const segment of segments) {
    if (segment.span) {
      (out[out.length - 1] as TelegramSegment[]).push(segment);
      continue;
    }
    segment.text.split('\n').forEach((piece, index) => {
      if (index > 0) out.push([]);
      if (piece.length > 0) (out[out.length - 1] as TelegramSegment[]).push(copy(piece));
    });
  }
  return out;
}

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || WHITESPACE.test(char);
}

function isPunctuation(char: string | undefined): boolean {
  return char !== undefined && PUNCTUATION.test(char);
}

/** The character beside a delimiter run as the flanking rules see it: an atom is a letter, a line edge whitespace. */
function neighbour(units: readonly Unit[], index: number): string | undefined {
  const unit = units[index];
  if (unit === undefined) return undefined;
  return unit.atom ? 'a' : unit.text;
}

interface DelimiterRun {
  readonly char: '*' | '_';
  /** Index of the run's first unit. */
  readonly start: number;
  /** Units still unmatched at each end (the run's inner ends are consumed first). */
  remaining: number;
  /** How many units were consumed from the left / right end. */
  usedLeft: number;
  usedRight: number;
  readonly length: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
}

/** Code spans: a backtick run closed by the next run of the same length on the line (CommonMark, one line). */
function markCodeSpans(units: readonly Unit[], removed: boolean[], code: boolean[]): void {
  let i = 0;
  while (i < units.length) {
    if (units[i]?.atom || units[i]?.text !== '`') {
      i += 1;
      continue;
    }
    let end = i;
    while (end < units.length && !units[end]?.atom && units[end]?.text === '`') end += 1;
    const length = end - i;
    let close = -1;
    let j = end;
    while (j < units.length) {
      if (units[j]?.atom || units[j]?.text !== '`') {
        j += 1;
        continue;
      }
      let runEnd = j;
      while (runEnd < units.length && !units[runEnd]?.atom && units[runEnd]?.text === '`') runEnd += 1;
      if (runEnd - j === length) {
        close = j;
        break;
      }
      j = runEnd;
    }
    if (close < 0) {
      i = end;
      continue;
    }
    for (let k = i; k < end; k += 1) removed[k] = true;
    for (let k = close; k < close + length; k += 1) removed[k] = true;
    for (let k = end; k < close; k += 1) code[k] = true;
    // CommonMark: one leading and one trailing space are stripped when both are there and the content is not all spaces.
    const first = units[end];
    const last = units[close - 1];
    const allSpaces = units.slice(end, close).every((unit) => !unit.atom && unit.text === ' ');
    if (close - end >= 2 && !allSpaces && first?.text === ' ' && !first.atom && last?.text === ' ' && !last.atom) {
      removed[end] = true;
      removed[close - 1] = true;
    }
    i = close + length;
  }
}

/** Emphasis: the CommonMark delimiter-run algorithm over `*` and `_`, outside code spans, never inside an atom. */
function markEmphasis(units: readonly Unit[], removed: boolean[], code: readonly boolean[]): void {
  const runs: DelimiterRun[] = [];
  let i = 0;
  while (i < units.length) {
    const unit = units[i] as Unit;
    if (unit.atom || code[i] || removed[i] || (unit.text !== '*' && unit.text !== '_')) {
      i += 1;
      continue;
    }
    const char = unit.text as '*' | '_';
    let end = i;
    while (end < units.length && !units[end]?.atom && !code[end] && !removed[end] && units[end]?.text === char) end += 1;
    const before = neighbour(units, i - 1);
    const after = neighbour(units, end);
    const left = !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
    const right = !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
    const canOpen = char === '*' ? left : left && (!right || isPunctuation(before));
    const canClose = char === '*' ? right : right && (!left || isPunctuation(after));
    runs.push({ char, start: i, length: end - i, remaining: end - i, usedLeft: 0, usedRight: 0, canOpen, canClose });
    i = end;
  }

  const openers: DelimiterRun[] = [];
  for (const run of runs) {
    if (run.canClose) {
      while (run.remaining > 0) {
        let found = -1;
        for (let k = openers.length - 1; k >= 0; k -= 1) {
          const opener = openers[k] as DelimiterRun;
          if (opener.char !== run.char || opener.remaining === 0) continue;
          // The rule of 3: a run that can both open and close does not pair when the sum is a multiple of 3 (unless both are).
          const both = (run.canOpen && run.canClose) || (opener.canOpen && opener.canClose);
          if (both && (opener.length + run.length) % 3 === 0 && !(opener.length % 3 === 0 && run.length % 3 === 0)) continue;
          found = k;
          break;
        }
        if (found < 0) break;
        const opener = openers[found] as DelimiterRun;
        const use = opener.remaining >= 2 && run.remaining >= 2 ? 2 : 1;
        // The opener gives its right (inner) end, the closer its left (inner) end.
        for (let k = 0; k < use; k += 1) removed[opener.start + opener.length - 1 - opener.usedRight - k] = true;
        for (let k = 0; k < use; k += 1) removed[run.start + run.usedLeft + k] = true;
        opener.usedRight += use;
        opener.remaining -= use;
        run.usedLeft += use;
        run.remaining -= use;
        // Openers between the pair can no longer match anything (CommonMark).
        openers.splice(found + 1);
        if (opener.remaining === 0) openers.splice(found, 1);
      }
    }
    if (run.canOpen && run.remaining > 0) openers.push(run);
  }
}

/** Inline translation of one line: code spans, then emphasis. Atoms are emitted unchanged. */
function translateInline(line: readonly TelegramSegment[]): string {
  const units: Unit[] = [];
  for (const segment of line) {
    if (segment.span) units.push({ text: segment.text, atom: true });
    else for (const char of segment.text) units.push({ text: char, atom: false });
  }
  const removed = units.map(() => false);
  const code = units.map(() => false);
  markCodeSpans(units, removed, code);
  markEmphasis(units, removed, code);
  let out = '';
  units.forEach((unit, index) => {
    if (!removed[index]) out += unit.text;
  });
  return out;
}

/** Line-level rules on a line's leading (and trailing) copy, then the inline rules. */
function translateLine(line: TelegramSegment[]): string {
  if (copyOnly(line) && THEMATIC_BREAK.test(lineText(line))) return lineText(line);
  const first = line[0];
  if (first !== undefined && !first.span) {
    if (HEADING.test(first.text)) {
      const rest = first.text.replace(HEADING, '');
      line = [...(rest.length > 0 ? [copy(rest)] : []), ...line.slice(1)];
      const last = line[line.length - 1];
      if (last !== undefined && !last.span && HEADING_CLOSE.test(last.text)) {
        line = [...line.slice(0, -1), copy(last.text.replace(HEADING_CLOSE, ''))];
      }
    } else if (BULLET.test(first.text)) {
      line = [copy(first.text.replace(BULLET, '$1• ')), ...line.slice(1)];
    }
  }
  return translateInline(line);
}

/** Translate rendered segments to Telegram plain text (rules in the module comment). Spans pass through unchanged. */
export function translateCommonMark(segments: readonly TelegramSegment[]): string {
  const out: string[] = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  for (const line of lines(segments)) {
    const text = lineText(line);
    if (fence !== undefined) {
      const close = copyOnly(line) ? FENCE_CLOSE.exec(text) : null;
      const run = close?.[1];
      if (run !== undefined && run[0] === fence.char && run.length >= fence.length) {
        fence = undefined;
        continue;
      }
      out.push(text);
      continue;
    }
    const open = copyOnly(line) ? FENCE_OPEN.exec(text) : null;
    const run = open?.[1];
    if (run !== undefined && !(run[0] === '`' && (open?.[2] ?? '').includes('`'))) {
      fence = { char: run[0] as string, length: run.length };
      continue;
    }
    out.push(translateLine(line));
  }
  return out.join('\n');
}

/**
 * The Telegram plain text of a body: its rendering with `markup`, translated. When the segment evaluator and Core's
 * own rendering disagree (`expected`), nothing is translated and Core's rendering is returned as it is (fail safe).
 */
export function translateTelegramBody(body: MessageBody, markup: MessageMarkup, expected: string): string {
  const segments = telegramSegments(body, markup);
  if (concat(segments) !== expected) return expected;
  return translateCommonMark(segments);
}
