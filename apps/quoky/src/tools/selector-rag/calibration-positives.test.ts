import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCalibrationPositives } from './gold';

function fixture(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cal-')), 'f.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe('frozen calibration positives (ADR-0123 D5)', () => {
  it('loads the checked-in fixture', () => {
    const positives = loadCalibrationPositives();
    expect(positives.length).toBeGreaterThan(0);
    expect(positives.map((p) => p.example)).toContain('오후만');
  });
  it('fails clearly when empty or malformed', () => {
    expect(() => loadCalibrationPositives(fixture({ positives: [] }))).toThrow(/no positives/);
    expect(() => loadCalibrationPositives(fixture({ positives: [{ example: 'x' }] }))).toThrow(/malformed/);
    expect(() => loadCalibrationPositives(fixture({ positives: [{ example: 'x', goldId: 'g', kind: 'near', charJ: 0.3 }] }))).toThrow(/below charJ 0.6/);
  });
});
