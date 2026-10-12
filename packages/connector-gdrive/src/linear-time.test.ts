import { describe, expect, it } from 'vitest';
import { DRIVE_FILE_NAME_MAX_LENGTH, DRIVE_TEXT_MAX_BYTES, boundDriveLine, buildUntrustedDocumentReadout } from '@quoky/core';
import { decodeBoundedUtf8 } from './text';
import { buildGDriveQuery } from './gdrive-reader';

/**
 * The GML-1 review P2-1 rule for Drive: a hostile file (shared with the owner by anyone) must not block the event loop.
 * The raw input is bounded before any processing, and every step is a single linear pass; the 500 ms bound leaves room
 * for a loaded CI host while still failing on any quadratic regression.
 */
const BOUND_MS = 500;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe('Drive text handling is linear on hostile input', () => {
  it.each([
    ['4 MiB of continuation bytes', new Uint8Array(4 * 1024 * 1024).fill(0x80)],
    ['4 MiB of NUL', new Uint8Array(4 * 1024 * 1024)],
    ['4 MiB of "가"', new TextEncoder().encode('가'.repeat(1_400_000))],
  ])('decodeBoundedUtf8: %s is cut at the bound before decoding', (_label, bytes) => {
    const { value, ms } = timed(() => decodeBoundedUtf8(bytes, DRIVE_TEXT_MAX_BYTES));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(value.truncated).toBe(true);
    expect(Buffer.byteLength(value.text, 'utf8')).toBeLessThanOrEqual(DRIVE_TEXT_MAX_BYTES * 3);
  });

  it('a code point split by the bound is dropped whole; a BOM is removed; a short text is untouched', () => {
    expect(decodeBoundedUtf8(new TextEncoder().encode('ab가'), 4)).toEqual({ text: 'ab', truncated: true });
    expect(decodeBoundedUtf8(new TextEncoder().encode('﻿한글 text'), 100)).toEqual({ text: '한글 text', truncated: false });
  });

  it.each([
    ['a 2 MB name of spaces and zero-width characters', `${' ​'.repeat(1_000_000)}x`],
    ['a 2 MB name of "<"', '<'.repeat(2_000_000)],
    ['a 2 MB name of "a." (a domain-shaped run)', 'a.'.repeat(1_000_000)],
  ])('boundDriveLine and the query builder: %s', (_label, name) => {
    const { value, ms } = timed(() => boundDriveLine(name, DRIVE_FILE_NAME_MAX_LENGTH));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(Array.from(value).length).toBeLessThanOrEqual(DRIVE_FILE_NAME_MAX_LENGTH);
    expect(timed(() => buildGDriveQuery(name.slice(0, 100))).ms).toBeLessThan(BOUND_MS);
  });

  it.each([
    ['256 KiB of CSV commas and blank cells', ','.repeat(DRIVE_TEXT_MAX_BYTES)],
    ['256 KiB of " \\n" pairs', ' \n'.repeat(DRIVE_TEXT_MAX_BYTES / 2)],
    ['256 KiB of domain-shaped labels', 'a.b'.repeat(DRIVE_TEXT_MAX_BYTES / 3)],
    ['256 KiB of zero-width characters', '​'.repeat(DRIVE_TEXT_MAX_BYTES / 3)],
  ])('the shared readout over a bounded Drive text: %s', (_label, body) => {
    const { ms } = timed(() => buildUntrustedDocumentReadout({ source: 'drive', title: 'x', author: '', date: '2026-10-08T00:00:00Z', body }));
    expect(ms).toBeLessThan(BOUND_MS * 2);
  });
});
