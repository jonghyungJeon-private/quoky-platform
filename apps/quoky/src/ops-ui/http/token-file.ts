import { closeSync, constants, fstatSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';

/**
 * The per-start access token file (ADR-0113 D3): `ops-ui.token` in the host data directory, mode `0600`.
 *
 * - A stale file left by an unclean stop is unlinked first (a symlink is unlinked, never followed).
 * - The new file is created exclusively (`O_CREAT | O_EXCL | O_NOFOLLOW`), so an attacker-placed file or symlink
 *   that appears between the unlink and the create makes the create fail instead of being written through.
 * - Any failure is reported as a code; the caller disables only the UI (fail closed). The token is never logged.
 * - On clean stop the file is removed, so a token never outlives its process.
 */

export const OPS_UI_TOKEN_FILE_NAME = 'ops-ui.token';

export type TokenFileFailure =
  | 'TOKEN_FILE_STALE_UNLINK_FAILED'
  | 'TOKEN_FILE_CREATE_FAILED'
  | 'TOKEN_FILE_WRITE_FAILED'
  | 'TOKEN_FILE_MODE_UNSAFE';

export type TokenFileResult = { readonly ok: true } | { readonly ok: false; readonly failure: TokenFileFailure };

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

/** Replace any stale token file at `filePath` with a fresh `0600` file holding `token`. */
export function writeTokenFile(filePath: string, token: string): TokenFileResult {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') return { ok: false, failure: 'TOKEN_FILE_STALE_UNLINK_FAILED' };
  }
  let fd: number;
  try {
    // O_NOFOLLOW is defined on macOS and Linux; it is 0 (no-op) only where unsupported, and O_EXCL already refuses
    // an existing path (symlinks included).
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(filePath, flags, 0o600);
  } catch {
    return { ok: false, failure: 'TOKEN_FILE_CREATE_FAILED' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      closeSync(fd);
      removeTokenFile(filePath);
      return { ok: false, failure: 'TOKEN_FILE_MODE_UNSAFE' };
    }
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
    closeSync(fd);
    return { ok: true };
  } catch {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    removeTokenFile(filePath);
    return { ok: false, failure: 'TOKEN_FILE_WRITE_FAILED' };
  }
}

/** Remove the token file; a missing file is fine. Never throws. */
export function removeTokenFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // missing or not removable: nothing more to do on the way out
  }
}
