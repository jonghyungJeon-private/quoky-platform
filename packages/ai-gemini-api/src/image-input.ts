import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AiImageInput } from '@quoky/core';
import { MAX_GEMINI_VISION_IMAGE_BYTES } from './gemini-api-config';

/** The leading bytes each admitted image type must start with (the file content, not its name, decides). */
const IMAGE_SIGNATURE: Readonly<Record<AiImageInput['mimeType'], (head: Buffer) => boolean>> = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

export type ImageReadOutcome = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly reason: 'REFUSED' | 'GONE' };

/**
 * Read one #143 canonical image (the intake's runner-owned temp file, ADR-0111 D1) in place: an absolute path, opened
 * without following a symlink, a regular non-empty file of at most {@link MAX_GEMINI_VISION_IMAGE_BYTES} checked on the
 * OPEN descriptor (no check-then-read race), whose content signature matches its declared type. The bytes live only
 * in memory for this request; the path and bytes never reach a log, an error or the result. (The same rules as the CLI
 * vision providers; adapters do not share code across packages.)
 */
export function readCanonicalImage(image: AiImageInput): ImageReadOutcome {
  const signature = IMAGE_SIGNATURE[image.mimeType];
  if (signature === undefined || typeof image.path !== 'string' || !isAbsolute(image.path)) {
    return { ok: false, reason: 'REFUSED' };
  }
  let fd: number;
  try {
    fd = openSync(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, reason: 'GONE' };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_GEMINI_VISION_IMAGE_BYTES) return { ok: false, reason: 'REFUSED' };
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== bytes.length || !signature(bytes)) return { ok: false, reason: 'REFUSED' };
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: 'REFUSED' };
  } finally {
    closeSync(fd);
  }
}
