import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConnectorQueryError } from './connector-query';
import {
  DRIVE_LISTING_MAX_ENTRIES,
  boundDriveLine,
  isDriveTextExportable,
  isValidDriveFileId,
  parseDriveNameQuery,
  resolveDriveListingLimit,
} from './drive-reader.port';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorQueryError);
    return (error as ConnectorQueryError).reason;
  }
  return undefined;
}

describe('DriveReader port (ADR-0118 D2, DRV-1)', () => {
  it('validates the owner-typed name: one line of 1..100 characters; the limit is clamped to 10', () => {
    expect(parseDriveNameQuery('  회의록   2026 ')).toBe('회의록 2026');
    expect(reasonOf(() => parseDriveNameQuery(' '))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseDriveNameQuery('a\nb'))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseDriveNameQuery('x'.repeat(101)))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseDriveNameQuery(7))).toBe('UNSUPPORTED_QUERY');
    expect(resolveDriveListingLimit(undefined)).toBe(DRIVE_LISTING_MAX_ENTRIES);
    expect(resolveDriveListingLimit(50)).toBe(10);
    expect(reasonOf(() => resolveDriveListingLimit(0))).toBe('UNSUPPORTED_QUERY');
  });

  it('bounds untrusted names (raw cut first, linear on a hostile name) and validates opaque ids', () => {
    expect(boundDriveLine('a\u0000b c​d\n e', 100)).toBe('a b cd e');
    expect(boundDriveLine('가'.repeat(10), 5)).toBe('가가가가…');
    expect(boundDriveLine(null, 5)).toBe('');
    const start = performance.now();
    expect(Array.from(boundDriveLine(` ${'​ '.repeat(2_000_000)}x`, 200)).length).toBeLessThanOrEqual(200);
    expect(performance.now() - start).toBeLessThan(500);
    expect(isValidDriveFileId('1AbC_d-EfG')).toBe(true);
    for (const id of ['', '../x', 'a b', 'x'.repeat(129), 7, 'a/export']) expect(isValidDriveFileId(id)).toBe(false);
  });

  it('only documents and spreadsheets have a text export; an uploaded text file does not (ADR-0118 D2)', () => {
    expect(['document', 'spreadsheet'].every(isDriveTextExportable)).toBe(true);
    expect(['text', 'presentation', 'pdf', 'folder', 'other', 'image', undefined].some(isDriveTextExportable)).toBe(false);
  });

  it('declares no write method: the port is search, recent and export only', () => {
    const source = readFileSync(new URL('./drive-reader.port.ts', import.meta.url), 'utf8');
    const reader = source.slice(source.indexOf('export interface DriveReader {'), source.indexOf('export function parseDriveNameQuery'));
    const methods = [...reader.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]);
    expect(methods).toEqual(['searchByName', 'recentFiles', 'exportText']);
  });
});
