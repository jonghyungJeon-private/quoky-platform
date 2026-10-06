import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPrivateEnvFile } from './env-file-guard';

const dirs: string[] = [];
function envFile(mode: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'quoky-envguard-'));
  dirs.push(dir);
  const file = path.join(dir, '.env.local');
  writeFileSync(file, 'SECRET_VALUE_SHOULD_NEVER_APPEAR=1\n');
  chmodSync(file, mode);
  return file;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('assertPrivateEnvFile (ADR-0102 D2)', () => {
  it('accepts an owner-only file (600 and 400)', () => {
    expect(() => assertPrivateEnvFile(envFile(0o600))).not.toThrow();
    expect(() => assertPrivateEnvFile(envFile(0o400))).not.toThrow();
  });

  it.each([0o640, 0o644, 0o604, 0o660, 0o200])('refuses mode %o with ENV_FILE_INSECURE', (mode) => {
    expect(() => assertPrivateEnvFile(envFile(mode))).toThrow(expect.objectContaining({ code: 'ENV_FILE_INSECURE' }));
  });

  it('refuses a file owned by another user', () => {
    const file = envFile(0o600);
    expect(() => assertPrivateEnvFile(file, { uid: 999_999 })).toThrow(
      expect.objectContaining({ code: 'ENV_FILE_INSECURE' }),
    );
  });

  it('refuses a relative path, a missing file and a directory', () => {
    expect(() => assertPrivateEnvFile('.env.local')).toThrow(expect.objectContaining({ code: 'ENV_FILE_NOT_ABSOLUTE' }));
    const file = envFile(0o600);
    expect(() => assertPrivateEnvFile(`${file}.missing`)).toThrow(expect.objectContaining({ code: 'ENV_FILE_MISSING' }));
    expect(() => assertPrivateEnvFile(path.dirname(file))).toThrow(expect.objectContaining({ code: 'ENV_FILE_MISSING' }));
  });

  it('never puts the path or file content in the error', () => {
    const file = envFile(0o644);
    try {
      assertPrivateEnvFile(file);
      throw new Error('expected a refusal');
    } catch (err) {
      const text = `${(err as Error).message} ${(err as { hint?: string }).hint ?? ''}`;
      expect(text).not.toContain(file);
      expect(text).not.toContain('SECRET_VALUE_SHOULD_NEVER_APPEAR');
    }
  });
});
