/**
 * Pure helpers that turn the Gmail API's message JSON into bounded text (ADR-0118 D2/D7). Nothing here makes a request.
 * Bounds: the MIME walk visits at most {@link MAX_MIME_PARTS} parts to depth {@link MAX_MIME_DEPTH}; a decoded body is
 * cut to the caller's byte bound. Attachments (parts with a filename or an attachment id) are never read.
 */

export const MAX_MIME_PARTS = 100;
export const MAX_MIME_DEPTH = 10;

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
export function decodeMimeHeader(value: string): string {
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
  const angle = /^(.*?)<([^<>\s]{1,320})>\s*$/.exec(decoded);
  if (angle) {
    const name = (angle[1] ?? '').trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1').trim();
    return { name, address: (angle[2] ?? '').trim() };
  }
  if (/^[^\s@<>]+@[^\s@<>]+$/.test(decoded)) return { name: '', address: decoded };
  return { name: decoded.replace(/^"(.*)"$/s, '$1').trim(), address: '' };
}

/** Text from an HTML body: script/style/head dropped, block tags become line breaks, tags removed, entities decoded. */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|head|title|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|table)\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]{0,2000}>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
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
export function extractBodyText(payload: unknown): string {
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
  if (plain !== undefined) return decodeBytes(decodeBase64Url(plain.data), plain.charset);
  if (html !== undefined) return htmlToText(decodeBytes(decodeBase64Url(html.data), html.charset));
  return '';
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
