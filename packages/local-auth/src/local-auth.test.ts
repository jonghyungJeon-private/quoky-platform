import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SIGN_IN_LOCKOUT_MS,
  SIGN_IN_MAX_FAILURES,
  SIGN_IN_WINDOW_MS,
  SignInRateLimiter,
  constantTimeEquals,
  newSecret,
  removeTokenFile,
  writeTokenFile,
} from './index';

describe('local auth secrets (ADR-0125 D11)', () => {
  it('generates independent 256-bit base64url values', () => {
    const first = newSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(newSecret() === first).toBe(false);
  });

  it('compares equal, unequal and different-length values', () => {
    const value = newSecret();
    expect(constantTimeEquals(value, value)).toBe(true);
    expect(constantTimeEquals(newSecret(), value)).toBe(false);
    expect(constantTimeEquals(value.slice(1), value)).toBe(false);
    expect(constantTimeEquals('', value)).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});

describe('single-owner failure limiter (unchanged OPS-UI semantics)', () => {
  let now = 0;
  beforeEach(() => { now = 0; });

  it('locks on the fifth failure and expires at exactly 60 seconds', () => {
    const limiter = new SignInRateLimiter(() => now);
    expect(SIGN_IN_MAX_FAILURES).toBe(5);
    expect(SIGN_IN_WINDOW_MS).toBe(60_000);
    expect(SIGN_IN_LOCKOUT_MS).toBe(60_000);
    for (let i = 1; i < SIGN_IN_MAX_FAILURES; i++) limiter.recordFailure();
    expect(limiter.isLocked()).toBe(false);
    limiter.recordFailure();
    expect(limiter.isLocked()).toBe(true);
    now += SIGN_IN_LOCKOUT_MS - 1;
    expect(limiter.isLocked()).toBe(true);
    now++;
    expect(limiter.isLocked()).toBe(false);
  });

  it('drops failures at the window boundary', () => {
    const limiter = new SignInRateLimiter(() => now);
    for (let i = 1; i < SIGN_IN_MAX_FAILURES; i++) limiter.recordFailure();
    now += SIGN_IN_WINDOW_MS;
    limiter.recordFailure();
    expect(limiter.isLocked()).toBe(false);
  });

  it('success clears failures but does not shorten an existing lockout', () => {
    const limiter = new SignInRateLimiter(() => now);
    for (let i = 1; i < SIGN_IN_MAX_FAILURES; i++) limiter.recordFailure();
    limiter.recordSuccess();
    limiter.recordFailure();
    expect(limiter.isLocked()).toBe(false);
    for (let i = 1; i < SIGN_IN_MAX_FAILURES; i++) limiter.recordFailure();
    limiter.recordSuccess();
    expect(limiter.isLocked()).toBe(true);
    now += SIGN_IN_LOCKOUT_MS;
    expect(limiter.isLocked()).toBe(false);
    limiter.recordFailure();
    expect(limiter.isLocked()).toBe(false);
  });
});

describe('local auth token files (ADR-0113 D3)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'local-auth-'));
    file = path.join(dir, 'access');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes a private regular file with a trailing newline and removes it idempotently', () => {
    const value = newSecret();
    expect(writeTokenFile(file, value)).toEqual({ ok: true });
    expect(lstatSync(file).isFile()).toBe(true);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8') === `${value}\n`).toBe(true);
    removeTokenFile(file);
    expect(existsSync(file)).toBe(false);
    expect(() => removeTokenFile(file)).not.toThrow();
  });

  it('replaces a stale file', () => {
    writeFileSync(file, newSecret());
    const value = newSecret();
    expect(writeTokenFile(file, value)).toEqual({ ok: true });
    expect(readFileSync(file, 'utf8') === `${value}\n`).toBe(true);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it('unlinks a stale symlink without changing its target', () => {
    const target = path.join(dir, 'target');
    const original = newSecret();
    writeFileSync(target, original);
    symlinkSync(target, file);
    expect(writeTokenFile(file, newSecret())).toEqual({ ok: true });
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8') === original).toBe(true);
  });

  it('returns only a failure code if a stale path cannot be unlinked', () => {
    expect(writeTokenFile(dir, newSecret())).toEqual({ ok: false, failure: 'TOKEN_FILE_STALE_UNLINK_FAILED' });
    expect(() => removeTokenFile(dir)).not.toThrow();
  });

  it('returns only a failure code if the parent is missing', () => {
    expect(writeTokenFile(path.join(dir, 'missing', 'access'), newSecret())).toEqual({
      ok: false, failure: 'TOKEN_FILE_CREATE_FAILED',
    });
  });
});
