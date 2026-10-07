import { deflateSync, inflateSync } from 'node:zlib';
import type { InboundImageMimeType } from '@quoky/core';

/**
 * Structural validation and canonicalization of an inbound image (Codex P1 on df66418) BEFORE it can reach any vision
 * provider. A magic-byte check alone let a "PNG" that was the signature plus `password=…`, or a valid PNG with text
 * appended, through to a cloud provider unscreened. Pure TypeScript plus the Node built-in zlib (no native dependency):
 *
 * - **PNG:** every chunk from the signature to `IEND` is length- and CRC-checked; an unknown critical chunk, a chunk
 *   out of order, non-consecutive `IDAT`s or any byte after `IEND` is refused; `IHDR` is validated (dimensions up to
 *   {@link MAX_IMAGE_DIMENSION}, a legal bit depth / colour type, no unknown methods). The image data is inflated, its
 *   exact scanline size and filter bytes are checked, and it is RE-DEFLATED into one fresh `IDAT`; the output is
 *   `IHDR`, `sRGB` (1 byte 0–3), `gAMA` (4 bytes > 0), `PLTE` and `tRNS` (indexed colour only), `IDAT`, `IEND`, each
 *   kept only with its exact structure. Text, metadata, profiles, `cHRM`, `pHYs`, grey/RGB `tRNS` and every other
 *   chunk (`tEXt`, `zTXt`, `iTXt`, `eXIf`, `iCCP`, …) are dropped.
 * - **JPEG:** every segment from `SOI` to `EOI` is walked and its length validated; table segments are parsed to their
 *   exact length; only baseline / extended / progressive Huffman frames are accepted; `APP1`–`APP13`, `APP15` and
 *   `COM` are dropped, a JFIF `APP0` is replaced by a fixed canonical JFIF segment and an Adobe `APP14` by a fixed
 *   segment carrying only the colour transform (clamped to 0–2); any byte after `EOI` is refused.
 * - **WebP:** the RIFF size must equal the file length minus 8 and the chunks must consume it exactly; a simple
 *   lossy (`VP8 `) or lossless (`VP8L`) image, or `VP8X` + optional `ALPH` + one bitstream, is accepted (animation is
 *   refused); `ICCP`, `EXIF`, `XMP ` and unknown chunks are dropped and `VP8X` is rebuilt (or omitted) to match.
 *
 * Residual (documented): content inside the pixel data itself — a screenshot showing a secret, steganography, or
 * bytes placed in a JPEG/WebP entropy-coded bitstream — cannot be screened structurally. The caller additionally runs
 * the credential guard over printable runs of the canonical bytes.
 */

/** Largest accepted width or height. */
export const MAX_IMAGE_DIMENSION = 12_000;
/** Largest decoded PNG scanline data that is inflated for verification (bounded memory). */
export const MAX_PNG_RAW_BYTES = 128 * 1024 * 1024;

export type ImageCheckCode =
  | 'TRUNCATED'
  | 'TRAILING_BYTES'
  | 'BAD_SIGNATURE'
  | 'BAD_CRC'
  | 'BAD_HEADER'
  | 'BAD_DIMENSIONS'
  | 'BAD_STRUCTURE'
  | 'UNKNOWN_CRITICAL'
  | 'UNSUPPORTED_VARIANT'
  | 'BAD_IMAGE_DATA'
  | 'TOO_LARGE_TO_VERIFY';

export type CanonicalImage =
  | { readonly ok: true; readonly bytes: Buffer; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly code: ImageCheckCode };

class ImageCheckError extends Error {
  constructor(readonly code: ImageCheckCode) {
    super(code);
  }
}

function fail(code: ImageCheckCode): never {
  throw new ImageCheckError(code);
}

/** Validates and canonicalizes `bytes` as `mimeType`; never throws. */
export function canonicalizeImage(bytes: Buffer, mimeType: InboundImageMimeType): CanonicalImage {
  try {
    switch (mimeType) {
      case 'image/png':
        return { ok: true, ...canonicalPng(bytes) };
      case 'image/jpeg':
        return { ok: true, ...canonicalJpeg(bytes) };
      case 'image/webp':
        return { ok: true, ...canonicalWebp(bytes) };
    }
  } catch (err) {
    return { ok: false, code: err instanceof ImageCheckError ? err.code : 'BAD_STRUCTURE' };
  }
}

function checkDimensions(width: number, height: number): void {
  if (!(width >= 1 && height >= 1 && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION)) fail('BAD_DIMENSIONS');
}

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk with a valid length and CRC (`raw` = length + type + data + CRC). */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
/** Ancillary chunks kept (rendering only, no text or metadata), and where they go. */
const PNG_BEFORE_PLTE = new Set(['sRGB', 'gAMA']);
const ADAM7: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** `sRGB`: one rendering-intent byte 0–3; `gAMA`: a non-zero 4-byte gamma. */
function validColorSpaceChunk(type: string, data: Buffer): boolean {
  if (type === 'sRGB') return data.length === 1 && (data[0] as number) <= 3;
  if (type === 'gAMA') return data.length === 4 && data.readUInt32BE(0) > 0;
  return false;
}

/** The scanline row lengths (filter byte included) of the image, in stored order. */
function pngRows(width: number, height: number, bitsPerPixel: number, interlaced: boolean): number[] {
  const rowBytes = (w: number) => 1 + Math.ceil((w * bitsPerPixel) / 8);
  if (!interlaced) return Array.from({ length: height }, () => rowBytes(width));
  const rows: number[] = [];
  for (const [xs, ys, xstep, ystep] of ADAM7) {
    const pw = width > xs ? Math.ceil((width - xs) / xstep) : 0;
    const ph = height > ys ? Math.ceil((height - ys) / ystep) : 0;
    if (pw === 0 || ph === 0) continue;
    for (let r = 0; r < ph; r++) rows.push(rowBytes(pw));
  }
  return rows;
}

function canonicalPng(bytes: Buffer): { bytes: Buffer; width: number; height: number } {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail('BAD_SIGNATURE');
  let offset = 8;
  let ihdr: Buffer | undefined;
  let plte: Buffer | undefined;
  let seenPlte = false;
  let trns: Buffer | undefined;
  const colorSpace: Buffer[] = [];
  const idat: Buffer[] = [];
  let idatClosed = false;
  let ended = false;
  while (!ended) {
    if (offset + 12 > bytes.length) fail('TRUNCATED');
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + 12 + length > bytes.length) fail('TRUNCATED');
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(type)) fail('BAD_STRUCTURE');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail('BAD_CRC');
    offset += 12 + length;
    const critical = type.charCodeAt(0) >= 0x41 && type.charCodeAt(0) <= 0x5a;
    if (ihdr === undefined && type !== 'IHDR') fail('BAD_STRUCTURE');
    if (idat.length > 0 && type !== 'IDAT') idatClosed = true;
    switch (type) {
      case 'IHDR':
        if (ihdr !== undefined || length !== 13) fail('BAD_HEADER');
        ihdr = Buffer.from(data);
        break;
      case 'PLTE': {
        if (seenPlte || idat.length > 0) fail('BAD_STRUCTURE');
        seenPlte = true;
        const header = ihdr as Buffer;
        const colorType = header[9] as number;
        const entries = length / 3;
        const valid =
          length > 0 && length % 3 === 0 && length <= 768 && (colorType !== 3 || entries <= 2 ** (header[8] as number));
        // Required (and must be valid) for indexed colour. For RGB(A) it is only a quantization suggestion that never
        // changes rendering, and for grey(+alpha) it is not allowed: dropped in both cases (its bytes are arbitrary).
        if (colorType === 3 && !valid) fail('BAD_STRUCTURE');
        if (colorType === 3) plte = Buffer.from(data);
        break;
      }
      case 'IDAT':
        if (idatClosed) fail('BAD_STRUCTURE');
        idat.push(data);
        break;
      case 'IEND':
        if (length !== 0 || idat.length === 0) fail('BAD_STRUCTURE');
        ended = true;
        break;
      default:
        if (critical) fail('UNKNOWN_CRITICAL');
        // Kept rendering ancillaries are only meaningful before the image data; anything else is dropped.
        if (idat.length > 0) break;
        // Each kept chunk must have its exact structure (Codex P2 on 9a39152); a malformed one is dropped, never copied.
        if (
          PNG_BEFORE_PLTE.has(type) &&
          !seenPlte &&
          validColorSpaceChunk(type, data) &&
          !colorSpace.some((c) => c.toString('latin1', 4, 8) === type)
        ) {
          colorSpace.push(pngChunk(type, Buffer.from(data)));
        } else if (type === 'tRNS' && trns === undefined && (ihdr as Buffer)[9] === 3 && seenPlte) {
          // Indexed colour only (palette transparency); validated against the palette size when the output is assembled.
          // Grey/RGB tRNS (one free colour value), cHRM, pHYs and every other ancillary are dropped: the image renders
          // without them and they would carry free values.
          trns = Buffer.from(data);
        }
    }
  }
  if (offset !== bytes.length) fail('TRAILING_BYTES');
  const header = ihdr as Buffer;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8] as number;
  const colorType = header[9] as number;
  checkDimensions(width, height);
  if (!(PNG_DEPTHS[colorType] ?? []).includes(depth)) fail('BAD_HEADER');
  if (header[10] !== 0 || header[11] !== 0 || (header[12] !== 0 && header[12] !== 1)) fail('BAD_HEADER');
  if (colorType === 3 && plte === undefined) fail('BAD_STRUCTURE');
  const rows = pngRows(width, height, (PNG_CHANNELS[colorType] as number) * depth, header[12] === 1);
  const rawSize = rows.reduce((sum, row) => sum + row, 0);
  if (rawSize > MAX_PNG_RAW_BYTES) fail('TOO_LARGE_TO_VERIFY');
  const compressed = Buffer.concat(idat);
  let raw: Buffer;
  try {
    const result = inflateSync(compressed, { info: true, maxOutputLength: rawSize + 1 }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    // Bytes after the end of the zlib stream are not image data.
    if (result.engine.bytesWritten !== compressed.length) fail('BAD_IMAGE_DATA');
    raw = result.buffer;
  } catch (err) {
    if (err instanceof ImageCheckError) throw err;
    fail('BAD_IMAGE_DATA');
  }
  if (raw.length !== rawSize) fail('BAD_IMAGE_DATA');
  let at = 0;
  for (const row of rows) {
    if ((raw[at] as number) > 4) fail('BAD_IMAGE_DATA');
    at += row;
  }
  // Kept only for indexed colour, bounded by the palette size.
  const trnsOk = trns !== undefined && colorType === 3 && plte !== undefined && trns.length >= 1 && trns.length <= plte.length / 3;
  const out = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    ...colorSpace,
    ...(plte !== undefined ? [pngChunk('PLTE', plte)] : []),
    ...(trnsOk ? [pngChunk('tRNS', trns as Buffer)] : []),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return { bytes: out, width, height };
}

// ── JPEG ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Accepted frame types: baseline, extended sequential and progressive (Huffman). */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2]);
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function validateDqt(payload: Buffer): void {
  let at = 0;
  while (at < payload.length) {
    const pq = (payload[at] as number) >> 4;
    const tq = (payload[at] as number) & 0x0f;
    if (pq > 1 || tq > 3) fail('BAD_STRUCTURE');
    at += 1 + 64 * (pq + 1);
  }
  if (at !== payload.length || payload.length === 0) fail('BAD_STRUCTURE');
}

function validateDht(payload: Buffer): void {
  let at = 0;
  while (at < payload.length) {
    const tc = (payload[at] as number) >> 4;
    const th = (payload[at] as number) & 0x0f;
    if (tc > 1 || th > 3 || at + 17 > payload.length) fail('BAD_STRUCTURE');
    let count = 0;
    for (let i = 1; i <= 16; i++) count += payload[at + i] as number;
    if (count > 256) fail('BAD_STRUCTURE');
    at += 17 + count;
  }
  if (at !== payload.length || payload.length === 0) fail('BAD_STRUCTURE');
}

/** The fixed canonical JFIF APP0 payload: version 1.01, no units, density 1×1, no thumbnail. No input byte is copied. */
const CANONICAL_JFIF = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

/** A fixed Adobe APP14 payload (DCTEncode version 100, no flags) carrying only the colour transform, clamped to 0–2. */
function canonicalAdobe(transform: number): Buffer {
  return Buffer.from([0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, Math.min(transform, 2)]);
}

function canonicalJpeg(bytes: Buffer): { bytes: Buffer; width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('BAD_SIGNATURE');
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let at = 2;
  let frame: { width: number; height: number } | undefined;
  let tables = 0;
  let scans = 0;
  let jfifKept = false;
  let adobeKept = false;
  for (;;) {
    if (at + 2 > bytes.length) fail('TRUNCATED');
    if (bytes[at] !== 0xff) fail('BAD_STRUCTURE');
    // Fill bytes (0xFF) before a marker are allowed.
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    if (at >= bytes.length) fail('TRUNCATED');
    const marker = bytes[at] as number;
    at += 1;
    if (marker === JPEG_EOI) {
      if (frame === undefined || scans === 0) fail('BAD_STRUCTURE');
      if (at !== bytes.length) fail('TRAILING_BYTES');
      out.push(Buffer.from([0xff, JPEG_EOI]));
      break;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) fail('BAD_STRUCTURE');
    if (at + 2 > bytes.length) fail('TRUNCATED');
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) fail('TRUNCATED');
    const payload = bytes.subarray(at + 2, at + length);
    at += length;
    if (marker >= 0xe0 && marker <= 0xef) {
      // APPn: a JFIF APP0 becomes the fixed canonical JFIF segment and an Adobe APP14 a fixed segment carrying only
      // its colour transform; no other byte of either is copied. Everything else is dropped.
      if (marker === 0xe0 && !jfifKept && frame === undefined && payload.length >= 5 && payload.toString('latin1', 0, 5) === 'JFIF\u0000') {
        out.push(segment(0xe0, CANONICAL_JFIF));
        jfifKept = true;
      } else if (marker === 0xee && !adobeKept && payload.length === 12 && payload.toString('latin1', 0, 5) === 'Adobe') {
        out.push(segment(0xee, canonicalAdobe(payload[11] as number)));
        adobeKept = true;
      }
      continue;
    }
    if (marker === 0xfe) continue; // COM
    if (marker === 0xdb) {
      validateDqt(payload);
      tables += 1;
      out.push(segment(marker, Buffer.from(payload)));
      continue;
    }
    if (marker === 0xc4) {
      validateDht(payload);
      out.push(segment(marker, Buffer.from(payload)));
      continue;
    }
    if (marker === 0xdd) {
      if (payload.length !== 2) fail('BAD_STRUCTURE');
      out.push(segment(marker, Buffer.from(payload)));
      continue;
    }
    if (JPEG_SOF.has(marker)) {
      if (frame !== undefined || payload.length < 6) fail('BAD_STRUCTURE');
      const precision = payload[0] as number;
      const height = payload.readUInt16BE(1);
      const width = payload.readUInt16BE(3);
      const components = payload[5] as number;
      if ((precision !== 8 && precision !== 12) || components < 1 || components > 4 || payload.length !== 6 + 3 * components) {
        fail('BAD_HEADER');
      }
      checkDimensions(width, height);
      frame = { width, height };
      out.push(segment(marker, Buffer.from(payload)));
      continue;
    }
    if (marker === JPEG_SOS) {
      const count = payload[0] as number;
      if (frame === undefined || tables === 0 || count < 1 || count > 4 || payload.length !== 4 + 2 * count) fail('BAD_STRUCTURE');
      // Entropy-coded data runs to the next marker that is neither a stuffed 0xFF00 nor a restart marker.
      const start = at;
      for (;;) {
        if (at + 1 >= bytes.length) fail('TRUNCATED');
        if (bytes[at] === 0xff) {
          const next = bytes[at + 1] as number;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            at += 2;
            continue;
          }
          if (next === 0xff) {
            at += 1;
            continue;
          }
          break;
        }
        at += 1;
      }
      scans += 1;
      out.push(segment(marker, Buffer.from(payload)), Buffer.from(bytes.subarray(start, at)));
      continue;
    }
    // SOF of an unsupported process (lossless, arithmetic, hierarchical), DAC, DNL, DHP, EXP, JPGn, …
    fail('UNSUPPORTED_VARIANT');
  }
  const { width, height } = frame as { width: number; height: number };
  return { bytes: Buffer.concat(out), width, height };
}

// ── WebP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface RiffChunk {
  readonly fourcc: string;
  readonly payload: Buffer;
}

function riffChunk(fourcc: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function vp8Dimensions(payload: Buffer): { width: number; height: number; alpha: false } {
  if (payload.length < 10) fail('TRUNCATED');
  const tag = (payload[0] as number) | ((payload[1] as number) << 8) | ((payload[2] as number) << 16);
  if ((tag & 1) !== 0) fail('BAD_HEADER'); // must be a key frame
  const firstPartition = tag >>> 5;
  if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) fail('BAD_SIGNATURE');
  if (firstPartition > payload.length - 10) fail('TRUNCATED');
  const width = payload.readUInt16LE(6) & 0x3fff;
  const height = payload.readUInt16LE(8) & 0x3fff;
  checkDimensions(width, height);
  return { width, height, alpha: false };
}

function vp8lDimensions(payload: Buffer): { width: number; height: number; alpha: boolean } {
  if (payload.length < 5) fail('TRUNCATED');
  if (payload[0] !== 0x2f) fail('BAD_SIGNATURE');
  const bits = payload.readUInt32LE(1);
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >>> 14) & 0x3fff) + 1;
  if (bits >>> 29 !== 0) fail('BAD_HEADER');
  checkDimensions(width, height);
  return { width, height, alpha: ((bits >>> 28) & 1) === 1 };
}

function canonicalWebp(bytes: Buffer): { bytes: Buffer; width: number; height: number } {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') {
    fail('BAD_SIGNATURE');
  }
  const riffSize = bytes.readUInt32LE(4);
  if (riffSize + 8 < bytes.length) fail('TRAILING_BYTES');
  if (riffSize + 8 > bytes.length) fail('TRUNCATED');
  const chunks: RiffChunk[] = [];
  let at = 12;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) fail('TRUNCATED');
    const fourcc = bytes.toString('latin1', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const padded = size + (size % 2);
    if (at + 8 + size > bytes.length) fail('TRUNCATED');
    chunks.push({ fourcc, payload: bytes.subarray(at + 8, at + 8 + size) });
    at += 8 + padded;
  }
  if (at !== bytes.length) fail('TRUNCATED');
  const [first, ...rest] = chunks;
  if (first === undefined) fail('BAD_STRUCTURE');
  if (first.fourcc === 'VP8 ' || first.fourcc === 'VP8L') {
    // Simple format: exactly one bitstream chunk; anything after it is dropped (unknown chunks are ignorable).
    if (rest.some((chunk) => chunk.fourcc === 'VP8 ' || chunk.fourcc === 'VP8L' || chunk.fourcc === 'VP8X')) fail('BAD_STRUCTURE');
    const dims = first.fourcc === 'VP8 ' ? vp8Dimensions(first.payload) : vp8lDimensions(first.payload);
    return { bytes: riffWebp([riffChunk(first.fourcc, Buffer.from(first.payload))]), width: dims.width, height: dims.height };
  }
  if (first.fourcc !== 'VP8X') fail('BAD_STRUCTURE');
  if (first.payload.length !== 10) fail('BAD_HEADER');
  const flags = first.payload[0] as number;
  if ((flags & 0x02) !== 0 || rest.some((chunk) => chunk.fourcc === 'ANIM' || chunk.fourcc === 'ANMF')) fail('UNSUPPORTED_VARIANT');
  const canvasWidth = 1 + first.payload.readUIntLE(4, 3);
  const canvasHeight = 1 + first.payload.readUIntLE(7, 3);
  checkDimensions(canvasWidth, canvasHeight);
  const bitstreams = rest.filter((chunk) => chunk.fourcc === 'VP8 ' || chunk.fourcc === 'VP8L');
  if (bitstreams.length !== 1) fail('BAD_STRUCTURE');
  const bitstream = bitstreams[0] as RiffChunk;
  const alphaChunks = rest.filter((chunk) => chunk.fourcc === 'ALPH');
  if (alphaChunks.length > 1 || (alphaChunks.length === 1 && bitstream.fourcc !== 'VP8 ')) fail('BAD_STRUCTURE');
  if (alphaChunks.length === 1 && rest.indexOf(alphaChunks[0] as RiffChunk) > rest.indexOf(bitstream)) fail('BAD_STRUCTURE');
  const dims = bitstream.fourcc === 'VP8 ' ? vp8Dimensions(bitstream.payload) : vp8lDimensions(bitstream.payload);
  if (dims.width !== canvasWidth || dims.height !== canvasHeight) fail('BAD_DIMENSIONS');
  const alpha = alphaChunks[0];
  if (alpha === undefined) {
    return { bytes: riffWebp([riffChunk(bitstream.fourcc, Buffer.from(bitstream.payload))]), width: dims.width, height: dims.height };
  }
  if (alpha.payload.length < 1) fail('TRUNCATED');
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x10; // alpha only: ICC, EXIF, XMP and animation flags are cleared with their chunks
  vp8x.writeUIntLE(canvasWidth - 1, 4, 3);
  vp8x.writeUIntLE(canvasHeight - 1, 7, 3);
  return {
    bytes: riffWebp([
      riffChunk('VP8X', vp8x),
      riffChunk('ALPH', Buffer.from(alpha.payload)),
      riffChunk(bitstream.fourcc, Buffer.from(bitstream.payload)),
    ]),
    width: dims.width,
    height: dims.height,
  };
}

function riffWebp(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
