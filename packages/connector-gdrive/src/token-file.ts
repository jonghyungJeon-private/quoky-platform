import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { DRIVE_READONLY_SCOPE } from './oauth';

/**
 * The local Drive refresh-token file (ADR-0118 D3, the ADR-0110 D2 pattern, as for GDrive): a small JSON file written
 * once by the owner's consent helper with mode 600 and read at startup. One grant set per file: it records
 * `drive.readonly` and nothing else, and it is never the calendar or GDrive token file. The reader refuses a symlink, a non-regular file, a file
 * another user owns, a file group or others can read or write, an oversized file and any other recorded scope. Errors
 * carry a fixed code only, never the path or the content.
 *
 * File shape: `{ "version": 1, "scope": "https://www.googleapis.com/auth/drive.readonly", "refresh_token": "<token>" }`.
 */

export const GDRIVE_TOKEN_FILE_VERSION = 1;
const TOKEN_FILE_MAX_BYTES = 16 * 1024;
const REFRESH_TOKEN_MAX_LENGTH = 4096;

export const GDriveTokenFileErrorCode = {
  UNREADABLE: 'GDRIVE_TOKEN_FILE_UNREADABLE',
  NOT_REGULAR: 'GDRIVE_TOKEN_FILE_NOT_REGULAR',
  NOT_OWNED: 'GDRIVE_TOKEN_FILE_NOT_OWNED',
  PERMISSIONS: 'GDRIVE_TOKEN_FILE_PERMISSIONS',
  TOO_LARGE: 'GDRIVE_TOKEN_FILE_TOO_LARGE',
  INVALID: 'GDRIVE_TOKEN_FILE_INVALID',
  EXISTS: 'GDRIVE_TOKEN_FILE_EXISTS',
} as const;
export type GDriveTokenFileErrorCode = (typeof GDriveTokenFileErrorCode)[keyof typeof GDriveTokenFileErrorCode];

/** A value-free token-file failure: the message is the code only. */
export class GDriveTokenFileError extends Error {
  constructor(readonly code: GDriveTokenFileErrorCode) {
    super(code);
    this.name = 'GDriveTokenFileError';
  }
}

/** Read the refresh token from a mode-600 GDrive token file this user owns. */
export function readGDriveTokenFile(path: string): string {
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink at the path is refused rather than followed.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new GDriveTokenFileError(code === 'ELOOP' ? GDriveTokenFileErrorCode.NOT_REGULAR : GDriveTokenFileErrorCode.UNREADABLE);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new GDriveTokenFileError(GDriveTokenFileErrorCode.NOT_REGULAR);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) throw new GDriveTokenFileError(GDriveTokenFileErrorCode.NOT_OWNED);
    if ((stat.mode & 0o077) !== 0) throw new GDriveTokenFileError(GDriveTokenFileErrorCode.PERMISSIONS);
    if (stat.size > TOKEN_FILE_MAX_BYTES) throw new GDriveTokenFileError(GDriveTokenFileErrorCode.TOO_LARGE);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return parseTokenFile(buffer.subarray(0, offset).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

/** Write a NEW GDrive token file with mode 600. An existing path is never overwritten (`EXISTS`). */
export function writeGDriveTokenFile(path: string, refreshToken: string, scope: string = DRIVE_READONLY_SCOPE): void {
  if (!isPlausibleGDriveRefreshToken(refreshToken)) throw new GDriveTokenFileError(GDriveTokenFileErrorCode.INVALID);
  if (scope !== DRIVE_READONLY_SCOPE) throw new GDriveTokenFileError(GDriveTokenFileErrorCode.INVALID);
  const content = `${JSON.stringify({ version: GDRIVE_TOKEN_FILE_VERSION, scope, refresh_token: refreshToken })}\n`;
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new GDriveTokenFileError(code === 'EEXIST' ? GDriveTokenFileErrorCode.EXISTS : GDriveTokenFileErrorCode.UNREADABLE);
  }
  try {
    fchmodSync(fd, 0o600); // the umask can only remove bits; this pins the mode exactly
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function parseTokenFile(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GDriveTokenFileError(GDriveTokenFileErrorCode.INVALID);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GDriveTokenFileError(GDriveTokenFileErrorCode.INVALID);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== GDRIVE_TOKEN_FILE_VERSION || record.scope !== DRIVE_READONLY_SCOPE) {
    throw new GDriveTokenFileError(GDriveTokenFileErrorCode.INVALID);
  }
  const token = record.refresh_token;
  if (typeof token !== 'string' || !isPlausibleGDriveRefreshToken(token)) {
    throw new GDriveTokenFileError(GDriveTokenFileErrorCode.INVALID);
  }
  return token;
}

/** Non-empty, bounded, printable ASCII with no whitespace. */
export function isPlausibleGDriveRefreshToken(value: string): boolean {
  return value.length > 0 && value.length <= REFRESH_TOKEN_MAX_LENGTH && /^[\x21-\x7e]+$/.test(value);
}
