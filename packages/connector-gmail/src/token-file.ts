import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { GMAIL_READONLY_SCOPE } from './oauth';

/**
 * The local Gmail refresh-token file (ADR-0118 D3, the ADR-0110 D2 pattern): a small JSON file written once by the
 * owner's consent helper with mode 600 and read at startup. One grant set per file: it records `gmail.readonly` and
 * nothing else, and it is never the calendar token file. The reader refuses a symlink, a non-regular file, a file
 * another user owns, a file group or others can read or write, an oversized file and any other recorded scope. Errors
 * carry a fixed code only, never the path or the content.
 *
 * File shape: `{ "version": 1, "scope": "https://www.googleapis.com/auth/gmail.readonly", "refresh_token": "<token>" }`.
 */

export const GMAIL_TOKEN_FILE_VERSION = 1;
const TOKEN_FILE_MAX_BYTES = 16 * 1024;
const REFRESH_TOKEN_MAX_LENGTH = 4096;

export const GmailTokenFileErrorCode = {
  UNREADABLE: 'GMAIL_TOKEN_FILE_UNREADABLE',
  NOT_REGULAR: 'GMAIL_TOKEN_FILE_NOT_REGULAR',
  NOT_OWNED: 'GMAIL_TOKEN_FILE_NOT_OWNED',
  PERMISSIONS: 'GMAIL_TOKEN_FILE_PERMISSIONS',
  TOO_LARGE: 'GMAIL_TOKEN_FILE_TOO_LARGE',
  INVALID: 'GMAIL_TOKEN_FILE_INVALID',
  EXISTS: 'GMAIL_TOKEN_FILE_EXISTS',
} as const;
export type GmailTokenFileErrorCode = (typeof GmailTokenFileErrorCode)[keyof typeof GmailTokenFileErrorCode];

/** A value-free token-file failure: the message is the code only. */
export class GmailTokenFileError extends Error {
  constructor(readonly code: GmailTokenFileErrorCode) {
    super(code);
    this.name = 'GmailTokenFileError';
  }
}

/** Read the refresh token from a mode-600 Gmail token file this user owns. */
export function readGmailTokenFile(path: string): string {
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink at the path is refused rather than followed.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new GmailTokenFileError(code === 'ELOOP' ? GmailTokenFileErrorCode.NOT_REGULAR : GmailTokenFileErrorCode.UNREADABLE);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new GmailTokenFileError(GmailTokenFileErrorCode.NOT_REGULAR);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) throw new GmailTokenFileError(GmailTokenFileErrorCode.NOT_OWNED);
    if ((stat.mode & 0o077) !== 0) throw new GmailTokenFileError(GmailTokenFileErrorCode.PERMISSIONS);
    if (stat.size > TOKEN_FILE_MAX_BYTES) throw new GmailTokenFileError(GmailTokenFileErrorCode.TOO_LARGE);
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

/** Write a NEW Gmail token file with mode 600. An existing path is never overwritten (`EXISTS`). */
export function writeGmailTokenFile(path: string, refreshToken: string, scope: string = GMAIL_READONLY_SCOPE): void {
  if (!isPlausibleGmailRefreshToken(refreshToken)) throw new GmailTokenFileError(GmailTokenFileErrorCode.INVALID);
  if (scope !== GMAIL_READONLY_SCOPE) throw new GmailTokenFileError(GmailTokenFileErrorCode.INVALID);
  const content = `${JSON.stringify({ version: GMAIL_TOKEN_FILE_VERSION, scope, refresh_token: refreshToken })}\n`;
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new GmailTokenFileError(code === 'EEXIST' ? GmailTokenFileErrorCode.EXISTS : GmailTokenFileErrorCode.UNREADABLE);
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
    throw new GmailTokenFileError(GmailTokenFileErrorCode.INVALID);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GmailTokenFileError(GmailTokenFileErrorCode.INVALID);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== GMAIL_TOKEN_FILE_VERSION || record.scope !== GMAIL_READONLY_SCOPE) {
    throw new GmailTokenFileError(GmailTokenFileErrorCode.INVALID);
  }
  const token = record.refresh_token;
  if (typeof token !== 'string' || !isPlausibleGmailRefreshToken(token)) {
    throw new GmailTokenFileError(GmailTokenFileErrorCode.INVALID);
  }
  return token;
}

/** Non-empty, bounded, printable ASCII with no whitespace. */
export function isPlausibleGmailRefreshToken(value: string): boolean {
  return value.length > 0 && value.length <= REFRESH_TOKEN_MAX_LENGTH && /^[\x21-\x7e]+$/.test(value);
}
