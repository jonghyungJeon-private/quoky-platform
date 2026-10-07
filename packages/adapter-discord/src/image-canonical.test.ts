import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalizeImage, MAX_IMAGE_DIMENSION } from './image-canonical';
import {
  jpegImage,
  jpegMarkers,
  jpegSegmentOf,
  pngChunk,
  pngChunkTypes,
  pngImage,
  PNG_SIGNATURE,
  riffChunk,
  riffWebp,
  vp8lPayload,
  vp8Payload,
  vp8xPayload,
} from './image-test-support';

const SECRET_TEXT = Buffer.from('pass' + 'word=SYNTHETIC_REVIEW_ONLY', 'latin1');

function ok(result: ReturnType<typeof canonicalizeImage>): Buffer {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.bytes;
}

describe('PNG canonicalization (Codex P1 on df66418)', () => {
  it('the Codex repros are refused: signature + text, the signature alone, a valid PNG + appended text', () => {
    expect(canonicalizeImage(Buffer.concat([PNG_SIGNATURE, SECRET_TEXT]), 'image/png')).toMatchObject({ ok: false, code: 'TRUNCATED' });
    expect(canonicalizeImage(PNG_SIGNATURE, 'image/png')).toMatchObject({ ok: false, code: 'TRUNCATED' });
    expect(canonicalizeImage(pngImage({ trailing: SECRET_TEXT }), 'image/png')).toEqual({ ok: false, code: 'TRAILING_BYTES' });
  });

  it('keeps IHDR, sRGB, one fresh IDAT and IEND; drops text, EXIF, ICC, pHYs and unknown chunks', () => {
    // The shape of the sips-made `chart-crop.png` (sRGB + eXIf), plus every text chunk and an unknown ancillary.
    const input = pngImage({
      beforeIdat: [
        pngChunk('sRGB', Buffer.from([0])),
        pngChunk('eXIf', Buffer.concat([Buffer.from('MM\u0000*', 'latin1'), SECRET_TEXT])),
        pngChunk('iCCP', Buffer.concat([Buffer.from('icc\u0000\u0000', 'latin1'), SECRET_TEXT])),
        pngChunk('tEXt', Buffer.concat([Buffer.from('Comment\u0000', 'latin1'), SECRET_TEXT])),
        pngChunk('zTXt', Buffer.from('k\u0000\u0000xx', 'latin1')),
        pngChunk('iTXt', Buffer.from('k\u0000\u0000\u0000\u0000\u0000v', 'latin1')),
        pngChunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])),
        pngChunk('quKy', SECRET_TEXT),
      ],
      afterIdat: [pngChunk('tEXt', SECRET_TEXT)],
    });
    const out = ok(canonicalizeImage(input, 'image/png'));
    expect(pngChunkTypes(out)).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND']);
    expect(out.includes(SECRET_TEXT)).toBe(false);
    // Still decodable: the re-deflated image data is the same scanlines.
    const idatAt = out.indexOf('IDAT', 8, 'latin1');
    const idat = out.subarray(idatAt + 4, idatAt + 4 + out.readUInt32BE(idatAt - 4));
    expect(inflateSync(idat)).toEqual(inflateSync(pngImage().subarray(8 + 25 + 8, -12 - 4)));
    // Canonical output is a fixed point.
    expect(ok(canonicalizeImage(out, 'image/png'))).toEqual(out);
  });

  it('refuses a bad CRC, an unknown critical chunk, chunks out of order and split IDATs', () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const badCrc = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr, { badCrc: true })]);
    expect(canonicalizeImage(badCrc, 'image/png')).toEqual({ ok: false, code: 'BAD_CRC' });
    expect(canonicalizeImage(pngImage({ beforeIdat: [pngChunk('QUKY', SECRET_TEXT)] }), 'image/png')).toEqual({ ok: false, code: 'UNKNOWN_CRITICAL' });
    const noIhdrFirst = Buffer.concat([PNG_SIGNATURE, pngChunk('sRGB', Buffer.from([0])), pngImage().subarray(8)]);
    expect(canonicalizeImage(noIhdrFirst, 'image/png')).toEqual({ ok: false, code: 'BAD_STRUCTURE' });
    const valid = pngImage();
    const idatAt = valid.indexOf('IDAT', 8, 'latin1') - 4;
    const idatLength = valid.readUInt32BE(idatAt);
    const idatChunk = valid.subarray(idatAt, idatAt + 12 + idatLength);
    const split = Buffer.concat([valid.subarray(0, idatAt), idatChunk, pngChunk('tEXt', Buffer.from('x')), idatChunk, pngChunk('IEND', Buffer.alloc(0))]);
    expect(canonicalizeImage(split, 'image/png')).toEqual({ ok: false, code: 'BAD_STRUCTURE' });
  });

  it('validates IHDR dimensions and the image data size', () => {
    expect(canonicalizeImage(pngImage({ width: MAX_IMAGE_DIMENSION + 1, height: 1 }), 'image/png')).toEqual({ ok: false, code: 'BAD_DIMENSIONS' });
    // An IDAT stream with text after the end of the zlib stream, or too little data, is not image data.
    const valid = pngImage();
    const idatAt = valid.indexOf('IDAT', 8, 'latin1');
    const idat = valid.subarray(idatAt + 4, idatAt + 4 + valid.readUInt32BE(idatAt - 4));
    const rebuild = (data: Buffer) => Buffer.concat([valid.subarray(0, idatAt - 4), pngChunk('IDAT', data), pngChunk('IEND', Buffer.alloc(0))]);
    expect(canonicalizeImage(rebuild(Buffer.concat([idat, SECRET_TEXT])), 'image/png')).toEqual({ ok: false, code: 'BAD_IMAGE_DATA' });
    expect(canonicalizeImage(rebuild(idat.subarray(0, idat.length - 6)), 'image/png')).toEqual({ ok: false, code: 'BAD_IMAGE_DATA' });
  });
});

describe('JPEG canonicalization', () => {
  it('drops APP1-APP15 and COM, keeps a thumbnail-free JFIF and the coding segments; refuses bytes after EOI', () => {
    const input = jpegImage({
      extraSegments: [
        jpegSegmentOf(0xe1, Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), SECRET_TEXT])),
        jpegSegmentOf(0xe2, SECRET_TEXT),
        jpegSegmentOf(0xed, SECRET_TEXT),
        jpegSegmentOf(0xfe, SECRET_TEXT),
      ],
    });
    const out = ok(canonicalizeImage(input, 'image/jpeg'));
    expect(jpegMarkers(out)).toEqual([0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
    expect(out.includes(SECRET_TEXT)).toBe(false);
    expect(out.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(ok(canonicalizeImage(out, 'image/jpeg'))).toEqual(out);
    expect(canonicalizeImage(jpegImage({ trailing: SECRET_TEXT }), 'image/jpeg')).toEqual({ ok: false, code: 'TRAILING_BYTES' });
    expect(canonicalizeImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), SECRET_TEXT]), 'image/jpeg')).toMatchObject({ ok: false });
    expect(canonicalizeImage(jpegImage().subarray(0, 40), 'image/jpeg')).toMatchObject({ ok: false });
  });

  it('validates SOF dimensions and refuses unsupported coding processes', () => {
    expect(canonicalizeImage(jpegImage({ width: MAX_IMAGE_DIMENSION + 1 }), 'image/jpeg')).toEqual({ ok: false, code: 'BAD_DIMENSIONS' });
    const lossless = Buffer.from(jpegImage());
    lossless[lossless.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc3;
    expect(canonicalizeImage(lossless, 'image/jpeg')).toEqual({ ok: false, code: 'UNSUPPORTED_VARIANT' });
  });
});

describe('WebP canonicalization', () => {
  it('accepts simple lossless and lossy images; refuses a RIFF size mismatch and trailing bytes', () => {
    const lossless = riffWebp([riffChunk('VP8L', vp8lPayload())]);
    expect(ok(canonicalizeImage(lossless, 'image/webp'))).toEqual(lossless);
    const lossy = riffWebp([riffChunk('VP8 ', vp8Payload(3, 2))]);
    expect(canonicalizeImage(lossy, 'image/webp')).toMatchObject({ ok: true, width: 3, height: 2 });
    expect(canonicalizeImage(riffWebp([riffChunk('VP8L', vp8lPayload())], { trailing: SECRET_TEXT }), 'image/webp')).toEqual({
      ok: false,
      code: 'TRAILING_BYTES',
    });
    expect(canonicalizeImage(riffWebp([riffChunk('VP8L', vp8lPayload())], { sizeDelta: 8 }), 'image/webp')).toEqual({ ok: false, code: 'TRUNCATED' });
  });

  it('drops EXIF, XMP, ICCP and unknown chunks from VP8X, rebuilding the header (or the simple format)', () => {
    const extended = riffWebp([
      riffChunk('VP8X', vp8xPayload(0x2c)),
      riffChunk('ICCP', SECRET_TEXT),
      riffChunk('VP8L', vp8lPayload()),
      riffChunk('EXIF', SECRET_TEXT),
      riffChunk('XMP ', SECRET_TEXT),
    ]);
    const out = ok(canonicalizeImage(extended, 'image/webp'));
    expect(out).toEqual(riffWebp([riffChunk('VP8L', vp8lPayload())]));
    const withAlpha = riffWebp([
      riffChunk('VP8X', vp8xPayload(0x18)),
      riffChunk('ALPH', Buffer.from([0, 1, 2])),
      riffChunk('VP8 ', vp8Payload()),
      riffChunk('EXIF', SECRET_TEXT),
    ]);
    const alphaOut = ok(canonicalizeImage(withAlpha, 'image/webp'));
    expect(alphaOut.includes(SECRET_TEXT)).toBe(false);
    expect(alphaOut.toString('latin1', 12, 16)).toBe('VP8X');
    expect(alphaOut[20]).toBe(0x10);
  });

  it('refuses animation and a canvas that does not match the bitstream', () => {
    const animated = riffWebp([riffChunk('VP8X', vp8xPayload(0x02)), riffChunk('ANIM', Buffer.alloc(6))]);
    expect(canonicalizeImage(animated, 'image/webp')).toEqual({ ok: false, code: 'UNSUPPORTED_VARIANT' });
    const mismatch = riffWebp([riffChunk('VP8X', vp8xPayload(0, 5, 5)), riffChunk('VP8L', vp8lPayload())]);
    expect(canonicalizeImage(mismatch, 'image/webp')).toEqual({ ok: false, code: 'BAD_DIMENSIONS' });
  });
});

describe('PNG keeps only IHDR, sRGB, gAMA, indexed PLTE/tRNS, IDAT, IEND, each with its exact structure', () => {
  const PWD = Buffer.from('pw' + 'd=x', 'latin1');
  const kept = (chunks: readonly Buffer[], colorType: 0 | 2 | 3 | 4 | 6 = 2) =>
    pngChunkTypes(ok(canonicalizeImage(pngImage({ colorType, beforeIdat: chunks }), 'image/png')));
  const palette = (entries: number) => pngChunk('PLTE', Buffer.alloc(entries * 3, 0x7f));
  const gamma = (value: number) => {
    const data = Buffer.alloc(4);
    data.writeUInt32BE(value, 0);
    return pngChunk('gAMA', data);
  };

  it('sRGB: kept only as one byte 0-3', () => {
    expect(kept([pngChunk('sRGB', Buffer.from([3]))])).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND']);
    const smuggled = pngImage({ beforeIdat: [pngChunk('sRGB', Buffer.concat([Buffer.from([0]), SECRET_TEXT]))] });
    const out = ok(canonicalizeImage(smuggled, 'image/png'));
    expect(pngChunkTypes(out)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(out.includes(SECRET_TEXT)).toBe(false);
    expect(kept([pngChunk('sRGB', Buffer.from([4]))])).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('gAMA: kept only as a non-zero 4-byte value', () => {
    expect(kept([gamma(45_455)])).toEqual(['IHDR', 'gAMA', 'IDAT', 'IEND']);
    expect(kept([gamma(0)])).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(kept([pngChunk('gAMA', Buffer.alloc(5, 1))])).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('cHRM and pHYs are always dropped, so a short credential packed into their numeric fields never survives', () => {
    const chrm = pngChunk('cHRM', Buffer.concat([PWD, Buffer.alloc(32 - PWD.length)]));
    const phys = pngChunk('pHYs', Buffer.concat([PWD, Buffer.from([0, 0, 0, 1])]));
    const out = ok(canonicalizeImage(pngImage({ beforeIdat: [chrm, phys] }), 'image/png'));
    expect(pngChunkTypes(out)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(out.includes(PWD)).toBe(false);
  });

  it('PLTE: required and valid for indexed colour; a suggested palette (RGB/RGBA) and a grey palette are dropped', () => {
    expect(kept([palette(4)], 3)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    expect(canonicalizeImage(pngImage({ colorType: 3, beforeIdat: [pngChunk('PLTE', Buffer.alloc(4))] }), 'image/png')).toEqual({ ok: false, code: 'BAD_STRUCTURE' });
    expect(canonicalizeImage(pngImage({ colorType: 3, beforeIdat: [palette(257)] }), 'image/png')).toEqual({ ok: false, code: 'BAD_STRUCTURE' });
    expect(canonicalizeImage(pngImage({ colorType: 3 }), 'image/png')).toEqual({ ok: false, code: 'BAD_STRUCTURE' });
    expect(kept([palette(2)], 2)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(kept([pngChunk('PLTE', Buffer.concat([Buffer.alloc(3), SECRET_TEXT]))], 6)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(kept([palette(2)], 0)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(kept([palette(2)], 4)).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('tRNS: indexed after PLTE with at most one entry per palette colour; never for grey+alpha or RGBA', () => {
    expect(kept([palette(4), pngChunk('tRNS', Buffer.alloc(4))], 3)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    expect(kept([palette(4), pngChunk('tRNS', Buffer.alloc(5))], 3)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    expect(kept([pngChunk('tRNS', Buffer.alloc(1)), palette(4)], 3)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    expect(kept([pngChunk('tRNS', Buffer.alloc(2))], 4)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(kept([pngChunk('tRNS', Buffer.alloc(6))], 6)).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it.each([
    ['grey', 0 as const, Buffer.from([0x00, 0x00])],
    // The builder's 1x1 RGB pixel is (0, 16, 32); the key matches it, so the pixel is fully transparent.
    ['RGB', 2 as const, Buffer.from([0x00, 0x00, 0x00, 0x10, 0x00, 0x20])],
  ])('a transparent 1x1 %s PNG keeps its tRNS byte-for-byte, so the pixel stays alpha 0 (Codex P2 on 3968792)', (_label, colorType, value) => {
    const trns = pngChunk('tRNS', value);
    const input = pngImage({ width: 1, height: 1, colorType, beforeIdat: [trns] });
    const out = ok(canonicalizeImage(input, 'image/png'));
    expect(pngChunkTypes(out)).toEqual(['IHDR', 'tRNS', 'IDAT', 'IEND']);
    expect(out.includes(trns)).toBe(true);
  });

  it('a grey/RGB tRNS with the wrong length or a sample above the bit depth is dropped', () => {
    expect(kept([pngChunk('tRNS', Buffer.alloc(6))], 0)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(kept([pngChunk('tRNS', Buffer.alloc(2))], 2)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(kept([pngChunk('tRNS', Buffer.concat([Buffer.alloc(6), Buffer.from('pw' + 'd=x', 'latin1')]))], 2)).toEqual(['IHDR', 'IDAT', 'IEND']);
    // 8-bit samples: 0x0100 is out of range.
    expect(kept([pngChunk('tRNS', Buffer.from([0x01, 0x00]))], 0)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(kept([pngChunk('tRNS', Buffer.from([0, 0, 0, 0xff, 0x01, 0x00]))], 2)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(kept([pngChunk('tRNS', Buffer.from([0, 0xff]))], 0)).toEqual(['IHDR', 'tRNS', 'IDAT', 'IEND']);
  });
});

describe('JPEG APP0 / APP14 are replaced by fixed segments (no input byte copied)', () => {
  const PWD = Buffer.from('pw' + 'd=x', 'latin1');
  const CANONICAL_JFIF = Buffer.concat([Buffer.from('JFIF\u0000', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);

  it('a JFIF APP0 carrying a credential in its density/thumbnail fields becomes the canonical JFIF segment', () => {
    const smuggled = jpegSegmentOf(0xe0, Buffer.concat([Buffer.from('JFIF\u0000', 'latin1'), Buffer.from([1, 2, 1]), PWD, Buffer.alloc(1), Buffer.from([1, 1]), Buffer.alloc(3, 0x41)]));
    const input = jpegImage();
    const app0End = 2 + 2 + input.readUInt16BE(4);
    const out = ok(canonicalizeImage(Buffer.concat([input.subarray(0, 2), smuggled, input.subarray(app0End)]), 'image/jpeg'));
    expect(out.subarray(2, 4 + 2 + CANONICAL_JFIF.length)).toEqual(Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), CANONICAL_JFIF]));
    expect(out.includes(PWD)).toBe(false);
  });

  it('an Adobe APP14 keeps only its colour transform (clamped to 0-2)', () => {
    const adobe = (rest: Buffer, transform: number) => jpegSegmentOf(0xee, Buffer.concat([Buffer.from('Adobe', 'latin1'), rest, Buffer.from([transform])]));
    const out = ok(canonicalizeImage(jpegImage({ extraSegments: [adobe(Buffer.concat([PWD, Buffer.alloc(1)]), 7)] }), 'image/jpeg'));
    expect(out.includes(PWD)).toBe(false);
    const at = out.indexOf(Buffer.from([0xff, 0xee]));
    expect(out.subarray(at + 4, at + 16)).toEqual(Buffer.concat([Buffer.from('Adobe', 'latin1'), Buffer.from([0, 0x64, 0, 0, 0, 0, 2])]));
    const one = ok(canonicalizeImage(jpegImage({ extraSegments: [adobe(Buffer.alloc(6), 1)] }), 'image/jpeg'));
    expect(one[one.indexOf(Buffer.from([0xff, 0xee])) + 15]).toBe(1);
  });
});
