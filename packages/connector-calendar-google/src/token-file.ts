import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { GOOGLE_CALENDAR_READONLY_SCOPE } from './oauth';

/**
 * The local refresh-token file (ADR-0110 D2): a small JSON file written once by the consent helper with mode 600 and
 * read at startup. The reader refuses a symlink, a non-regular file, a file another user owns, a file group or others
 * can read or write, an oversized file and any other scope. Errors carry a fixed code only, never the path's content.
 *
 * File shape: `{ "version": 1, "scope": "<calendar.readonly>", "refresh_token": "<token>" }`.
 */

export const GOOGLE_CALENDAR_TOKEN_FILE_VERSION = 1;
const TOKEN_FILE_MAX_BYTES = 16 * 1024;
const REFRESH_TOKEN_MAX_LENGTH = 4096;

export const GoogleCalendarTokenFileErrorCode = {
  UNREADABLE: 'CALENDAR_TOKEN_FILE_UNREADABLE',
  NOT_REGULAR: 'CALENDAR_TOKEN_FILE_NOT_REGULAR',
  NOT_OWNED: 'CALENDAR_TOKEN_FILE_NOT_OWNED',
  PERMISSIONS: 'CALENDAR_TOKEN_FILE_PERMISSIONS',
  TOO_LARGE: 'CALENDAR_TOKEN_FILE_TOO_LARGE',
  INVALID: 'CALENDAR_TOKEN_FILE_INVALID',
  EXISTS: 'CALENDAR_TOKEN_FILE_EXISTS',
} as const;
export type GoogleCalendarTokenFileErrorCode =
  (typeof GoogleCalendarTokenFileErrorCode)[keyof typeof GoogleCalendarTokenFileErrorCode];

/** A value-free token-file failure: the message is the code only. */
export class GoogleCalendarTokenFileError extends Error {
  constructor(readonly code: GoogleCalendarTokenFileErrorCode) {
    super(code);
    this.name = 'GoogleCalendarTokenFileError';
  }
}

/** Read the refresh token from a mode-600 token file this user owns. */
export function readGoogleCalendarTokenFile(path: string): string {
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink at the path is refused rather than followed.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new GoogleCalendarTokenFileError(
      code === 'ELOOP' ? GoogleCalendarTokenFileErrorCode.NOT_REGULAR : GoogleCalendarTokenFileErrorCode.UNREADABLE,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new GoogleCalendarTokenFileError(GoogleCalendarTokenFileErrorCode.NOT_REGULAR);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
      throw new GoogleCalendarTokenFileError(GoogleCalendarTokenFileErrorCode.NOT_OWNED);
    }
    if ((stat.mode & 0o077) !== 0) throw new GoogleCalendarTokenFileError(GoogleCalendarTokenFileErrorCode.PERMISSIONS);
    if (stat.size > TOKEN_FILE_MAX_BYTES) throw new GoogleCalendarTokenFileError(GoogleCalendarTokenFileErrorCode.TOO_LARGE);
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

/** Write a NEW token file with mode 600. An existing path is never overwritten (`EXISTS`). */
export function writeGoogleCalendarTokenFile(path: string, refreshToken: string): void {
  if (!isPlausibleRefreshToken(refreshToken)) throw new GoogleCalendarTokenFileError(GoogleCalendarTokenFileErrorCode.INVALID);
  const content = `${JSON.stringify({
    version: GOOGLE_CALENDAR_TOKEN_FILE_VERSION,
    scope: GOOGLE_CALENDAR_READONLY_SCOPE,
    refresh_token: refreshToken,
  })}\n`;
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new GoogleCalendarTokenFileError(
      code === 'EEXIST' ? GoogleCalendarTokenFileErrorCode.EXISTS : GoogleCalendarTokenFileErrorCode.UNREADABLE,
    );
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
    throw new GoogleCalendarTokenFileError(GoogleCalendarTokenFileErrorCode.INVALID);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GoogleCalendarTokenFileError(GoogleCalendarTokenFileErrorCode.INVALID);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== GOOGLE_CALENDAR_TOKEN_FILE_VERSION || record.scope !== GOOGLE_CALENDAR_READONLY_SCOPE) {
    throw new GoogleCalendarTokenFileError(GoogleCalendarTokenFileErrorCode.INVALID);
  }
  const token = record.refresh_token;
  if (typeof token !== 'string' || !isPlausibleRefreshToken(token)) {
    throw new GoogleCalendarTokenFileError(GoogleCalendarTokenFileErrorCode.INVALID);
  }
  return token;
}

/** Non-empty, bounded, printable ASCII with no whitespace (Google refresh tokens are of the form `1//…`). */
export function isPlausibleRefreshToken(value: string): boolean {
  return value.length > 0 && value.length <= REFRESH_TOKEN_MAX_LENGTH && /^[\x21-\x7e]+$/.test(value);
}
