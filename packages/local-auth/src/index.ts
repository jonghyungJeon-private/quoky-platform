import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';

/** ADR-0113 D3: 5 failed sign-ins per minute, then a 60 s lockout. */
export const SIGN_IN_MAX_FAILURES = 5;
export const SIGN_IN_WINDOW_MS = 60_000;
export const SIGN_IN_LOCKOUT_MS = 60_000;

/** A random 256-bit secret, base64url (43 characters). */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time string equality: both sides are hashed to fixed-length digests first, so neither the content nor the
 * length of the expected value is revealed by timing.
 */
export function constantTimeEquals(candidate: string, expected: string): boolean {
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b) && candidate.length === expected.length;
}

/** Global (single-owner, loopback) sign-in failure limiter. */
export class SignInRateLimiter {
  private failures: number[] = [];
  private lockedUntilMs = 0;

  constructor(private readonly nowMs: () => number) {}

  /** True while sign-in is refused (lockout). */
  isLocked(): boolean {
    return this.nowMs() < this.lockedUntilMs;
  }

  recordFailure(): void {
    const now = this.nowMs();
    this.failures = this.failures.filter((at) => now - at < SIGN_IN_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= SIGN_IN_MAX_FAILURES) {
      this.lockedUntilMs = now + SIGN_IN_LOCKOUT_MS;
      this.failures = [];
    }
  }

  recordSuccess(): void {
    this.failures = [];
  }
}

/**
 * The per-start access token file (ADR-0113 D3): `ops-ui.token` in the host data directory, mode `0600`.
 *
 * - A stale file left by an unclean stop is unlinked first (a symlink is unlinked, never followed).
 * - The new file is created exclusively (`O_CREAT | O_EXCL | O_NOFOLLOW`), so an attacker-placed file or symlink
 *   that appears between the unlink and the create makes the create fail instead of being written through.
 * - Any failure is reported as a code; the caller disables only the UI (fail closed). The token is never logged.
 * - On clean stop the file is removed, so a token never outlives its process.
 */

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
