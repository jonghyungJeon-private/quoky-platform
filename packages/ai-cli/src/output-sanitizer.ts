import { detectReplyLanguage } from '@quoky/core';
import type { GeneralChatReplyPolicy } from '@quoky/core';

const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x9b;
const OSC = 0x9d;
const ST = 0x9c;

function consumeCsi(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
    if (code < 0x20 || code > 0x3f) return i;
  }
  return input.length;
}

function consumeOsc(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === BEL || code === ST) return i + 1;
    if (code === ESC && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return input.length;
}

function consumeEscape(input: string, start: number): number {
  let i = start;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code > 0x2f) break;
    i += 1;
  }
  if (i < input.length) {
    const final = input.charCodeAt(i);
    if (final >= 0x30 && final <= 0x7e) return i + 1;
  }
  return start;
}

/**
 * Remove machine-recognizable terminal framing without interpreting natural
 * language. LF, CR, and TAB are intentionally preserved for Markdown output.
 */
export function sanitizeTerminalOutput(input: string): string {
  let output = '';

  for (let i = 0; i < input.length; ) {
    const code = input.charCodeAt(i);

    if (code === ESC) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x5b) {
        i = consumeCsi(input, i + 2);
        continue;
      }
      if (next === 0x5d) {
        i = consumeOsc(input, i + 2);
        continue;
      }
      i = consumeEscape(input, i + 1);
      continue;
    }

    if (code === CSI) {
      i = consumeCsi(input, i + 1);
      continue;
    }
    if (code === OSC) {
      i = consumeOsc(input, i + 1);
      continue;
    }

    const allowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    const disallowedControl =
      (!allowedWhitespace && code < 0x20) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f);
    if (disallowedControl) {
      i += 1;
      continue;
    }

    output += input[i];
    i += 1;
  }

  return output;
}

const INTERNAL_PROVENANCE = 'ASSISTANT';
const INTERNAL_EPISTEMIC_STATUS = 'ASSISTANT_NON_AUTHORITATIVE';

function contentFromJsonEnvelope(input: string): string | null {
  try {
    const envelope = JSON.parse(input) as Record<string, unknown>;
    const role = envelope.role;
    return (role === undefined || role === 'assistant') &&
      envelope.provenance === INTERNAL_PROVENANCE &&
      envelope.epistemicStatus === INTERNAL_EPISTEMIC_STATUS &&
      typeof envelope.content === 'string'
      ? envelope.content
      : null;
  } catch {
    return null;
  }
}

/**
 * Remove only the adapter's machine-recognizable Assistant metadata envelope.
 * Natural-language content is otherwise preserved verbatim; this does not
 * interpret the response or choose user-facing wording.
 */
export function stripInternalMetadataEnvelope(input: string): string {
  const trimmed = input.trim();
  const jsonContent = contentFromJsonEnvelope(trimmed);
  if (jsonContent !== null) return jsonContent;

  const lines = input.split(/\r?\n/u);
  const roleHeading = /^## (SYSTEM|USER|ASSISTANT|UNKNOWN) message$/u;

  // A model can echo the role-attributed stdin transcript. Once a canonical
  // role heading is present, accept content only from an Assistant block. In
  // particular, never turn an echoed USER Content field into the response.
  if (lines.some((line) => roleHeading.test(line.trim()))) {
    const assistantOutput: string[] = [];
    let role: string | null = null;

    for (const line of lines) {
      const normalized = line.trim();
      const heading = roleHeading.exec(normalized);
      if (heading) {
        role = heading[1] ?? null;
        continue;
      }
      if (normalized === '# Role-attributed conversation') continue;
      if (role !== 'ASSISTANT') continue;
      if (normalized === 'Provenance: ASSISTANT') continue;
      if (normalized === 'Epistemic status: ASSISTANT_NON_AUTHORITATIVE') continue;

      const content = decodeContentLine(line);
      assistantOutput.push(content ?? line);
    }

    while (assistantOutput[0]?.trim() === '') assistantOutput.shift();
    while (assistantOutput.at(-1)?.trim() === '') assistantOutput.pop();
    return assistantOutput.join('\n');
  }

  // The older headerless Assistant envelope is still accepted. A headerless
  // USER provenance marker is an echoed input, so fail closed instead of
  // replaying its Content field as an Assistant response.
  if (lines.some((line) => line.trim() === 'Provenance: USER')) return '';
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const normalized = (lines[index] ?? '').trim();

    if (normalized === '# Role-attributed conversation') continue;
    if (/^## (?:SYSTEM|USER|ASSISTANT|UNKNOWN) message$/u.test(normalized)) continue;
    if (/^Provenance: [A-Z][A-Z_]*$/u.test(normalized)) continue;
    if (/^Epistemic status: [A-Z][A-Z_]*$/u.test(normalized)) continue;

    const content = decodeContentLine(lines[index] ?? '');
    if (content !== null) {
      output.push(content);
      continue;
    }

    output.push(lines[index] ?? '');
  }

  while (output[0]?.trim() === '') output.shift();
  while (output.at(-1)?.trim() === '') output.pop();
  return output.join('\n');
}

function decodeContentLine(line: string): string | null {
  const normalized = line.trim();
  if (!normalized.startsWith('Content: ')) return null;
  try {
    const content = JSON.parse(normalized.slice('Content: '.length)) as unknown;
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  }
}

// Marker matching is per line and only on prose lines (never inside fenced or indented code). Up to three leading
// spaces, as in a Markdown paragraph; a deeper indent is an indented code block, not a heading.
const TRANSLATION_MARKER_LINE =
  /^ {0,3}[(\[]?[ \t]*(?:translated from [\p{L}]+|(?:english |korean )?translation|in english|in korean|(?:영어 |한국어 )?번역)[ \t]*(?:[:：)\]]|$)/iu;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const INDENTED_CODE_LINE = /^(?: {4}|[ ]{0,3}\t)/u;

interface SourceLine {
  /** Line text without its terminator. */
  readonly text: string;
  /** Offset of the first character of the line in the source text. */
  readonly start: number;
  /** True for a fence delimiter or a line inside a fenced code block. */
  readonly code: boolean;
}

/**
 * Split text into lines and classify each as prose or fenced code (CommonMark fences: ``` or ~~~, length >= 3, closed
 * by the same character with at least the opener's length and nothing but whitespace after it). A longer fence can
 * contain shorter ones, so nested examples stay inside the outer block. Returns `null` when a fence is left open, in
 * which case the code/prose split is not trustworthy.
 */
function classifyLines(text: string): SourceLine[] | null {
  const lines: SourceLine[] = [];
  const terminator = /\r?\n/gu;
  let start = 0;
  const raw: { text: string; start: number }[] = [];
  for (const match of text.matchAll(terminator)) {
    raw.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  raw.push({ text: text.slice(start), start });

  let fence: { char: string; length: number } | null = null;
  for (const line of raw) {
    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line.text);
      const run = close?.[1];
      if (run !== undefined && run[0] === fence.char && run.length >= fence.length) fence = null;
      lines.push({ ...line, code: true });
      continue;
    }
    const open = FENCE_OPEN.exec(line.text);
    const run = open?.[1];
    // A backtick fence's info string cannot contain a backtick (that is inline code, not a fence).
    if (run !== undefined && !(run[0] === '`' && (open?.[2] ?? '').includes('`'))) {
      fence = { char: run[0] ?? '`', length: run.length };
      lines.push({ ...line, code: true });
      continue;
    }
    lines.push({ ...line, code: false });
  }
  return fence === null ? lines : null;
}

/**
 * True when the end of `prose` is inside an inline code span opened earlier in the same paragraph. Conservative: an
 * unmatched backtick run counts as an open span, so a marker after it is never treated as prose.
 */
function endsInsideInlineCode(prose: string): boolean {
  let open: number | null = null;
  for (const match of prose.matchAll(/`+/gu)) {
    const length = match[0].length;
    if (open === null) open = length;
    else if (length === open) open = null;
  }
  return open !== null;
}

/**
 * Remove a final, explicitly marked translation block that the User did not ask for (e.g. a trailing
 * "(Translated from Korean)" section). The User-side facts come only from Core's structured `GeneralChatReplyPolicy`
 * (`AiRequest.metadata`), never from searching the serialized prompt. Only when: the User message has a detectable
 * language and carries no language or translation request; the marker is a prose line outside any fenced, indented or inline code; the
 * marked block runs to the end of the text and is prose only (no code block); the text before the marker is in the
 * User language; and the marked block is in the other script. Code is never inspected for markers or stripped, and an
 * unbalanced fence disables stripping entirely. Otherwise the text is returned unchanged.
 */
export function stripUnsolicitedTranslationBlock(
  text: string,
  replyPolicy: GeneralChatReplyPolicy | undefined,
): string {
  if (replyPolicy === undefined) return text;
  const userLanguage = replyPolicy.replyLanguage;
  if (userLanguage === 'unknown' || replyPolicy.explicitLanguageRequest) return text;

  const lines = classifyLines(text);
  if (lines === null) return text;

  let markerIndex = -1;
  let marker: RegExpExecArray | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.code) continue;
    const match = TRANSLATION_MARKER_LINE.exec(line.text);
    if (match === null) continue;
    markerIndex = index;
    marker = match;
    break;
  }
  if (marker === null) return text;
  const markerLine = lines[markerIndex];
  if (markerLine === undefined) return text;

  // The marker must not continue an inline code span opened earlier in its paragraph.
  const paragraph: string[] = [];
  for (let index = markerIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.code || line.text.trim() === '') break;
    paragraph.unshift(line.text);
  }
  if (endsInsideInlineCode(paragraph.join('\n'))) return text;

  // The translation section is the rest of the marker line plus every following line, and must be prose only.
  const trailing = lines.slice(markerIndex + 1);
  if (trailing.some((line) => line.code || INDENTED_CODE_LINE.test(line.text))) return text;

  const body = text.slice(0, markerLine.start);
  const block = text.slice(markerLine.start + marker[0].length);
  if (body.trim() === '') return text;
  if (detectReplyLanguage(body) !== userLanguage) return text;
  const blockLanguage = detectReplyLanguage(block);
  if (blockLanguage === 'unknown' || blockLanguage === userLanguage) return text;
  return body.trimEnd();
}

const CODE_SEGMENT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/u;
const LITERAL_NEWLINE = /(?<!\\)\\n/gu;

/**
 * Convert a literal two-character `\n` artifact to a real newline, outside code fences and inline code. Applies only
 * when the text has no real line break and at least two literal occurrences, so a single `\n` (or any `\n` in code
 * or a multi-line answer) is preserved.
 */
export function normalizeLiteralEscapes(text: string): string {
  if (/[\r\n]/u.test(text)) return text;
  const segments = text.split(CODE_SEGMENT);
  let occurrences = 0;
  for (let i = 0; i < segments.length; i += 2) {
    occurrences += segments[i]?.match(LITERAL_NEWLINE)?.length ?? 0;
  }
  if (occurrences < 2) return text;
  return segments
    .map((segment, index) => (index % 2 === 0 ? segment.replace(LITERAL_NEWLINE, '\n') : segment))
    .join('');
}

/** Provider-neutral GENERAL_CHAT output hygiene applied after `stripInternalMetadataEnvelope` (ADR-0098 D2). */
export function sanitizeGeneralChatText(output: string, replyPolicy?: GeneralChatReplyPolicy): string {
  return stripUnsolicitedTranslationBlock(normalizeLiteralEscapes(output), replyPolicy);
}
