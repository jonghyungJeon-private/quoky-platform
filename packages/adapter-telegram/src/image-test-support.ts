import { deflateSync } from 'node:zlib';
import { crc32 } from './image-canonical';

/**
 * Test-only builders of small, structurally valid images (and their tampered variants) for the intake and
 * canonicalization tests. Nothing here is used at runtime.
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Buffer, options: { badCrc?: boolean } = {}): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(Buffer.concat([head.subarray(4), data])) ^ (options.badCrc ? 1 : 0)) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export interface PngOptions {
  readonly width?: number;
  readonly height?: number;
  /** Chunks inserted between IHDR and IDAT. */
  readonly beforeIdat?: readonly Buffer[];
  /** Chunks inserted between IDAT and IEND. */
  readonly afterIdat?: readonly Buffer[];
  /** Bytes appended after IEND. */
  readonly trailing?: Buffer;
  /** PNG colour type (8-bit samples; indexed pixels use palette index 0). Default 2 (RGB). */
  readonly colorType?: 0 | 2 | 3 | 4 | 6;
  /** Pseudo-random (seeded, incompressible) pixels instead of a gradient. */
  readonly noise?: boolean;
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** An 8-bit PNG of the given size (a gradient, or seeded noise), with optional extra chunks. */
export function pngImage(options: PngOptions = {}): Buffer {
  const width = options.width ?? 4;
  const height = options.height ?? 3;
  const colorType = options.colorType ?? 2;
  const channels = CHANNELS[colorType] as number;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  let seed = 0x2545f491;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * channels);
    for (let x = 0; x < width * channels; x++) {
      if (colorType === 3) continue;
      if (options.noise) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        row[1 + x] = seed & 0xff;
      } else {
        row[1 + x] = (x * 16 + y * 32) & 0xff;
      }
    }
    rows.push(row);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...(options.beforeIdat ?? []),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    ...(options.afterIdat ?? []),
    pngChunk('IEND', Buffer.alloc(0)),
    options.trailing ?? Buffer.alloc(0),
  ]);
}

/** The chunk types of a PNG, in order. */
export function pngChunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    types.push(png.toString('latin1', offset + 4, offset + 8));
    offset += 12 + length;
  }
  return types;
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

export interface JpegOptions {
  readonly width?: number;
  readonly height?: number;
  /** Segments (already framed) inserted after APP0. */
  readonly extraSegments?: readonly Buffer[];
  readonly trailing?: Buffer;
}

export function jpegSegmentOf(marker: number, payload: Buffer): Buffer {
  return jpegSegment(marker, payload);
}

/**
 * A structurally valid baseline JPEG (one grey component, one DQT, one DHT, one scan). Its scan data is a fixed
 * placeholder: it is for structure tests (the decoder check runs locally against real encoder output).
 */
export function jpegImage(options: JpegOptions = {}): Buffer {
  const width = options.width ?? 8;
  const height = options.height ?? 8;
  const jfif = Buffer.concat([Buffer.from('JFIF\u0000', 'latin1'), Buffer.from([1, 1, 0, 0, 72, 0, 72, 0, 0])]);
  const dqt = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]);
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1; // component id
  sof[7] = 0x11; // sampling
  sof[8] = 0; // quant table
  const counts = Buffer.alloc(16);
  counts[0] = 1;
  const dht = Buffer.concat([Buffer.from([0x00]), counts, Buffer.from([0x00])]);
  const sos = Buffer.from([1, 1, 0x00, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, jfif),
    ...(options.extraSegments ?? []),
    jpegSegment(0xdb, dqt),
    jpegSegment(0xc0, sof),
    jpegSegment(0xc4, dht),
    jpegSegment(0xda, sos),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
    options.trailing ?? Buffer.alloc(0),
  ]);
}

/** The segment markers of a JPEG up to its first scan. */
export function jpegMarkers(jpeg: Buffer): number[] {
  const markers: number[] = [];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1] as number;
    markers.push(marker);
    if (marker === 0xda) break;
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  return markers;
}

export function riffChunk(fourcc: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

export function riffWebp(chunks: readonly Buffer[], options: { trailing?: Buffer; sizeDelta?: number } = {}): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + (options.sizeDelta ?? 0), 4);
  return Buffer.concat([head, body, options.trailing ?? Buffer.alloc(0)]);
}

/** A VP8L (lossless) bitstream header for `width` x `height` (placeholder image data after it). */
export function vp8lPayload(width = 1, height = 1): Buffer {
  const bits = Buffer.alloc(4);
  bits.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 0);
  return Buffer.concat([Buffer.from([0x2f]), bits, Buffer.from([0x00, 0x10, 0x07, 0x10, 0x11])]);
}

/** A VP8 (lossy) key-frame header for `width` x `height` (placeholder partition data after it). */
export function vp8Payload(width = 1, height = 1): Buffer {
  const frame = Buffer.alloc(20);
  // Frame tag: key frame (bit 0 = 0), version 0, show frame, first partition size 4.
  const tag = (4 << 5) | (1 << 4);
  frame[0] = tag & 0xff;
  frame[1] = (tag >> 8) & 0xff;
  frame[2] = (tag >> 16) & 0xff;
  frame[3] = 0x9d;
  frame[4] = 0x01;
  frame[5] = 0x2a;
  frame.writeUInt16LE(width, 6);
  frame.writeUInt16LE(height, 8);
  return frame;
}

export function vp8xPayload(flags: number, width = 1, height = 1): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return payload;
}
