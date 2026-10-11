/**
 * Bounded text helpers for the Drive adapter (ADR-0118 D7, ADR-0111 D2). Every helper is a single linear pass: a hostile
 * file (shared with the owner by anyone) cannot make the event loop block, and the raw input is cut to its byte bound
 * BEFORE it is decoded or touched by any regex.
 */

/**
 * Decode at most `maxBytes` of UTF-8: the bytes are cut first, a code point split by the cut is dropped (never a
 * replacement character at the end), and a leading byte-order mark is removed. Invalid sequences elsewhere become
 * U+FFFD (the decoder is not fatal). Returns whether anything was cut.
 */
export function decodeBoundedUtf8(bytes: Uint8Array, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  let end = Math.min(bytes.length, Math.max(0, maxBytes));
  const truncated = end < bytes.length;
  if (truncated) {
    // Step back over continuation bytes (10xxxxxx) to the start of the code point the cut split, at most 3 bytes.
    let back = end;
    while (back > 0 && end - back < 3 && ((bytes[back] ?? 0) & 0xc0) === 0x80) back -= 1;
    if (back < end && ((bytes[back] ?? 0) & 0xc0) !== 0x80) end = back;
  }
  let text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes.subarray(0, end));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, truncated };
}
