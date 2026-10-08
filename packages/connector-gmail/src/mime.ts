/**
 * Pure helpers that turn the Gmail API's message JSON into bounded text (ADR-0118 D2/D7). Nothing here makes a request.
 * Bounds: the MIME walk visits at most {@link MAX_MIME_PARTS} parts to depth {@link MAX_MIME_DEPTH}; a decoded body is
 * cut to the caller's byte bound. Attachments (parts with a filename or an attachment id) are never read.
 */

export const MAX_MIME_PARTS = 100;
export const MAX_MIME_DEPTH = 10;
/**
 * Review P2-1: a decoded body part is cut to this many bytes BEFORE any text processing, so the work on one mail is
 * bounded whatever the response held (the port returns at most 256 KiB anyway).
 */
export const MAX_RAW_BODY_BYTES = 512 * 1024;
/** Header values (From, Subject) and snippets are cut to this many UTF-16 units before any regex runs. */
export const MAX_HEADER_CHARS = 2_000;

/*
 * Every helper here is linear in its (bounded) input: no lazy `[\s\S]*?` span, no unbounded repetition followed by
 * an anchor that can fail, no bounded repetition that can rescan a long run at every position. Review P2-1 measured a
 * quadratic per-line trailing-space regex and a lazy paired-tag regex; both are now index scans.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Decode the HTML character references Gmail uses in snippets and HTML bodies (named basics and numeric forms). */
export function decodeHtmlEntities(value: string): string {
  // Linear: `&` then a bounded token then `;`; a failed match advances by one character.
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return codePoint(Number.parseInt(entity.slice(2), 16), match);
    if (entity.startsWith('#')) {
      const named = NAMED_ENTITIES[entity];
      return named ?? codePoint(Number.parseInt(entity.slice(1), 10), match);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function codePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return fallback;
  return String.fromCodePoint(value);
}

/** Decode with a declared charset (UTF-8 when absent, unknown or failing). */
export function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  try {
    return new TextDecoder(label.length > 0 ? label : 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** Gmail's base64url `body.data`, decoded to bytes (an invalid value yields no bytes). */
export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_\-+/=]*$/.test(value)) return new Uint8Array();
  return new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

/** RFC 2047 encoded words (`=?UTF-8?B?…?=`, `=?ISO-2022-JP?Q?…?=`) in a header value; other text is unchanged. */
export function decodeMimeHeader(raw: string): string {
  const value = raw.slice(0, MAX_HEADER_CHARS);
  if (!value.includes('=?')) return value;
  return value
    .replace(/(=\?[^?\s]{1,40}\?[bBqQ]\?[^?\s]{0,2000}\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?\s]{1,40})\?([bBqQ])\?([^?\s]{0,2000})\?=/g, (match, charset: string, encoding: string, text: string) => {
      try {
        const bytes =
          encoding.toUpperCase() === 'B'
            ? new Uint8Array(Buffer.from(text, 'base64'))
            : new Uint8Array(
                Buffer.from(
                  text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
                  'latin1',
                ),
              );
        return decodeBytes(bytes, charset.split('*')[0]);
      } catch {
        return match;
      }
    });
}

/** A `From` header split into a display name and an address. */
export function parseSender(value: string): { name: string; address: string } {
  const decoded = decodeMimeHeader(value).trim();
  // Index scan: the address is the last `<…>` group that ends the header (no backtracking regex).
  const close = decoded.length - 1;
  const open = decoded.lastIndexOf('<');
  if (decoded.endsWith('>') && open >= 0 && close - open - 1 >= 1 && close - open - 1 <= 320) {
    const address = decoded.slice(open + 1, close);
    if (!/[<>\s]/.test(address)) {
      const name = stripQuotes(decoded.slice(0, open).trim()).replace(/\\(.)/g, '$1').trim();
      return { name, address };
    }
  }
  if (/^[^\s@<>]+@[^\s@<>]+$/.test(decoded)) return { name: '', address: decoded };
  return { name: stripQuotes(decoded).trim(), address: '' };
}

function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** Elements whose content is never text. */
const DROPPED_ELEMENTS = new Set(['script', 'style', 'head', 'title', 'template', 'noscript']);
/** Closing tags that end a block (a line break). */
const BLOCK_END = /^\/(?:p|div|li|tr|h[1-6]|blockquote|section|article|table)\s*$/i;

/** The lower-case tag name at the start of a tag body (`style type="x"` → `style`), or ''. */
function tagName(body: string): string {
  let end = 0;
  while (end < body.length && end < 32 && /[A-Za-z0-9]/.test(body.charAt(end))) end += 1;
  return body.slice(0, end).toLowerCase();
}

/**
 * Text from an HTML body: comments and script/style/head/title/template/noscript elements dropped, block ends and
 * `<br>` become line breaks, `<li>` a dash, other tags a space, entities decoded. One left-to-right index scan:
 * an unclosed comment or dropped element ends the text (it never rescans), an unclosed `<` is kept as text.
 */
export function htmlToText(html: string): string {
  let out = '';
  let i = 0;
  const lower = (from: number, needle: string): number => {
    // Case-insensitive indexOf for an ASCII needle without lower-casing the whole input (lengths must stay aligned).
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'gi');
    re.lastIndex = from;
    return re.exec(html)?.index ?? -1;
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      out += ' ';
      i = end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) {
      out += html.slice(lt);
      break;
    }
    const body = html.slice(lt + 1, gt);
    const name = tagName(body);
    if (DROPPED_ELEMENTS.has(name)) {
      const close = lower(gt + 1, `</${name}`);
      if (close < 0) break;
      const closeEnd = html.indexOf('>', close);
      if (closeEnd < 0) break;
      out += ' ';
      i = closeEnd + 1;
      continue;
    }
    if (name === 'br') out += '\n';
    else if (name === 'li') out += '- ';
    else if (BLOCK_END.test(body)) out += '\n';
    else out += ' ';
    i = gt + 1;
  }
  return decodeHtmlEntities(out)
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface GmailPayloadPart {
  readonly mimeType?: unknown;
  readonly filename?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
  readonly parts?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A header value by case-insensitive name from a Gmail `headers` array (first match). */
export function headerValue(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  const wanted = name.toLowerCase();
  for (const entry of headers.slice(0, 200)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name === 'string' && entry.name.toLowerCase() === wanted && typeof entry.value === 'string') {
      return entry.value;
    }
  }
  return undefined;
}

function charsetOf(part: Record<string, unknown>): string | undefined {
  const contentType = headerValue(part.headers, 'Content-Type');
  const match = contentType === undefined ? null : /charset\s*=\s*"?([A-Za-z0-9_.:-]{1,40})"?/i.exec(contentType);
  return match?.[1];
}

function isAttachment(part: Record<string, unknown>): boolean {
  if (typeof part.filename === 'string' && part.filename.length > 0) return true;
  if (isRecord(part.body) && typeof part.body.attachmentId === 'string') return true;
  const disposition = headerValue(part.headers, 'Content-Disposition');
  return disposition !== undefined && /^\s*attachment/i.test(disposition);
}

/**
 * The readable body of a Gmail `payload`: the first inline `text/plain` part, else the first inline `text/html` part
 * reduced to text. Returns `''` when there is none. The walk is bounded in parts and depth.
 */
export function extractBodyText(payload: unknown): { text: string; truncated: boolean } {
  let plain: { data: string; charset?: string } | undefined;
  let html: { data: string; charset?: string } | undefined;
  let visited = 0;
  const walk = (node: unknown, depth: number): void => {
    if (plain !== undefined || visited >= MAX_MIME_PARTS || depth > MAX_MIME_DEPTH || !isRecord(node)) return;
    visited += 1;
    const mimeType = typeof node.mimeType === 'string' ? node.mimeType.toLowerCase() : '';
    if (Array.isArray(node.parts)) {
      for (const child of node.parts) walk(child, depth + 1);
      return;
    }
    if (isAttachment(node) || !isRecord(node.body) || typeof node.body.data !== 'string') return;
    const charset = charsetOf(node);
    const entry = { data: node.body.data, ...(charset !== undefined ? { charset } : {}) };
    if (mimeType === 'text/plain' && plain === undefined) plain = entry;
    else if (mimeType === 'text/html' && html === undefined) html = entry;
  };
  walk(payload, 0);
  const chosen = plain ?? html;
  if (chosen === undefined) return { text: '', truncated: false };
  const bytes = decodeBase64Url(chosen.data);
  const truncated = bytes.length > MAX_RAW_BODY_BYTES;
  const decoded = decodeBytes(truncated ? bytes.subarray(0, MAX_RAW_BODY_BYTES) : bytes, chosen.charset);
  return { text: chosen === plain ? decoded : htmlToText(decoded), truncated };
}

/** Cut `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return { text: out, truncated: true };
}
