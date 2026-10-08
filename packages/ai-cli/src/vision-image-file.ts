import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AiFailureKind, AiProviderError } from '@quoky/core';
import type { AiImageInput } from '@quoky/core';

/** Images per request (ADR-0111 D2 bounds a message to 3 attachments). Shared by the cloud vision providers. */
export const MAX_VISION_IMAGES = 3;
/** Image file bound (ADR-0111 D2: images ≤ 8 MiB), re-checked on the open file before it is read. */
export const MAX_VISION_IMAGE_BYTES = 8 * 1024 * 1024;

/** The leading bytes each admitted image type must start with (the file content, not its name, decides). */
const IMAGE_SIGNATURE: Readonly<Record<AiImageInput['mimeType'], (head: Buffer) => boolean>> = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

/** The fixed failure messages of one provider (never a path, never file or CLI content). */
export interface VisionImageMessages {
  readonly refused: string;
  readonly unavailable: string;
}

/**
 * Read one runner-owned temp image in place (ADR-0111 D1): an absolute path, opened without following a symlink, a
 * regular non-empty file of at most {@link MAX_VISION_IMAGE_BYTES} checked on the OPEN descriptor (no check-then-read
 * race), whose content signature matches its declared type. The bytes live only in memory for this request; the path
 * and bytes never reach a log, an error or the result.
 */
export function readVisionImageFile(image: AiImageInput, messages: VisionImageMessages): Buffer {
  const signature = IMAGE_SIGNATURE[image.mimeType];
  if (signature === undefined || typeof image.path !== 'string' || !isAbsolute(image.path)) {
    throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, messages.refused);
  }
  let fd: number;
  try {
    fd = openSync(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, messages.unavailable);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_VISION_IMAGE_BYTES) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, messages.refused);
    }
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== bytes.length || !signature(bytes)) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, messages.refused);
    }
    return bytes;
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, messages.refused);
  } finally {
    closeSync(fd);
  }
}

/** Replace every occurrence of the given paths in `text` with `<image>` (a model may quote a path it was shown). */
export function scrubImagePaths(text: string, paths: readonly string[]): string {
  return paths.reduce((acc, path) => (path ? acc.split(path).join('<image>') : acc), text);
}
