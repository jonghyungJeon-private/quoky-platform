import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isCliPresent } from './cli-presence';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('isCliPresent (a filesystem lookup, never a spawn)', () => {
  it('finds an executable regular file on PATH or at a path; refuses directories, non-executables and junk', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'quoky-cli-'));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
    chmodSync(path.join(bin, 'codex'), 0o755);
    writeFileSync(path.join(bin, 'ollama'), 'not executable');
    chmodSync(path.join(bin, 'ollama'), 0o644);
    mkdirSync(path.join(bin, 'claude'));
    expect(isCliPresent('codex', bin)).toBe(true);
    expect(isCliPresent(path.join(bin, 'codex'), '')).toBe(true);
    expect(isCliPresent('ollama', bin)).toBe(false);
    expect(isCliPresent('claude', bin)).toBe(false);
    expect(isCliPresent('missing', bin)).toBe(false);
    expect(isCliPresent('codex', '')).toBe(false);
    expect(isCliPresent('', bin)).toBe(false);
    expect(isCliPresent('co\ndex', bin)).toBe(false);
  });
});
